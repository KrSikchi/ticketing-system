'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { config, redis, cleanRedis, startTestServer } = require('./helpers');

describe('Step 4 (Findings 1 & 3): Charge-before-check and session expiry/reconciler safety', () => {
  let srv;

  before(async () => {
    srv = await startTestServer();
  });

  beforeEach(async () => {
    await cleanRedis();
  });

  after(async () => {
    if (srv) await srv.close();
  });

  it('does NOT charge when hold expired before /pay (paidAt unset, outcome EXPIRED)', async () => {
    const unit = 30;
    const bookingId = crypto.randomUUID();

    // Hold and checkout
    const holdRes = await srv.request('POST', '/hold', {
      headers: { 'x-user-id': 'alice' },
      body: { unit },
    });
    assert.equal(holdRes.status, 200);

    const coRes = await srv.request('POST', '/checkout', {
      headers: { 'x-user-id': 'alice' },
      body: { unit, bookingId },
    });
    assert.equal(coRes.status, 200);

    // Simulate hold expiring before /pay arrives
    await redis.del(config.holdKey(unit));

    const payRes = await srv.request('POST', '/pay', {
      headers: { 'x-user-id': 'alice' },
      body: { bookingId },
    });
    assert.equal(payRes.status, 410);
    assert.equal(payRes.json.reason, 'EXPIRED');

    // Verify no charge occurred: paidAt must NOT be set on the session
    const session = await redis.hgetall(config.payKey(bookingId));
    assert.equal(session.paidAt, undefined, 'paidAt must be unset when hold expired before pay');
    assert.equal(session.status, 'PENDING');
  });

  it('does NOT charge when seat was sold to someone else before /pay', async () => {
    const unit = 31;
    const bookingId = crypto.randomUUID();

    await srv.request('POST', '/hold', {
      headers: { 'x-user-id': 'alice' },
      body: { unit },
    });
    await srv.request('POST', '/checkout', {
      headers: { 'x-user-id': 'alice' },
      body: { unit, bookingId },
    });

    // Seat becomes sold to another bookingId meanwhile
    await redis.hset(config.soldKey(), String(unit), crypto.randomUUID());

    const payRes = await srv.request('POST', '/pay', {
      headers: { 'x-user-id': 'alice' },
      body: { bookingId },
    });
    assert.equal(payRes.status, 409);
    assert.equal(payRes.json.reason, 'SOLD');

    const session = await redis.hgetall(config.payKey(bookingId));
    assert.equal(session.paidAt, undefined, 'paidAt must be unset when seat already sold');
  });

  it('when initial session TTL is shorter than gateway delay, seat stays sold, retry returns BOOKED, and no partial session is created', async () => {
    const unit = 32;
    const bookingId = crypto.randomUUID();

    await srv.request('POST', '/hold', {
      headers: { 'x-user-id': 'alice' },
      body: { unit },
    });
    await srv.request('POST', '/checkout', {
      headers: { 'x-user-id': 'alice' },
      body: { unit, bookingId },
    });

    // Shrink session TTL to 2ms and make gateway take 40ms by delaying inside /pay
    await redis.pexpire(config.payKey(bookingId), 50);

    // Wait 2ms, then call /pay while temporarily increasing PAYMENT_DELAY_MS if possible,
    // or expire the session right before pay_finish if not extended by pay_begin
    const origSetTimeout = global.setTimeout;
    global.setTimeout = (fn, ms, ...args) => {
      if (ms === config.PAYMENT_DELAY_MS) {
        return origSetTimeout(fn, 80, ...args);
      }
      return origSetTimeout(fn, ms, ...args);
    };

    let payRes;
    try {
      payRes = await srv.request('POST', '/pay', {
        headers: { 'x-user-id': 'alice' },
        body: { bookingId },
      });
    } finally {
      global.setTimeout = origSetTimeout;
    }

    assert.equal(payRes.status, 200);
    assert.equal(payRes.json.status, 'BOOKED');
    assert.equal(await redis.hget(config.soldKey(), String(unit)), bookingId);

    // Retrying /pay must return 200 BOOKED (not 403 FORBIDDEN due to missing user/unit)
    const retryPay = await srv.request('POST', '/pay', {
      headers: { 'x-user-id': 'alice' },
      body: { bookingId },
    });
    assert.equal(retryPay.status, 200);
    assert.equal(retryPay.json.status, 'BOOKED');

    // Session in Redis must still have user and unit intact
    const session = await redis.hgetall(config.payKey(bookingId));
    assert.equal(session.user, 'alice');
    assert.equal(session.unit, String(unit));
    assert.equal(session.status, 'PAID');
  });

  it('double-click /pay charges exactly once and both callers get valid outcomes', async () => {
    const unit = 33;
    const bookingId = crypto.randomUUID();

    await srv.request('POST', '/hold', {
      headers: { 'x-user-id': 'alice' },
      body: { unit },
    });
    await srv.request('POST', '/checkout', {
      headers: { 'x-user-id': 'alice' },
      body: { unit, bookingId },
    });

    let randomCalls = 0;
    const origRandom = Math.random;
    Math.random = () => {
      randomCalls += 1;
      return 0.99;
    };

    let r1;
    let r2;
    try {
      [r1, r2] = await Promise.all([
        srv.request('POST', '/pay', { headers: { 'x-user-id': 'alice' }, body: { bookingId } }),
        srv.request('POST', '/pay', { headers: { 'x-user-id': 'alice' }, body: { bookingId } }),
      ]);
    } finally {
      Math.random = origRandom;
    }

    assert.equal(randomCalls, 1, 'gateway must be charged at most once on concurrent double-click');
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 202]);
  });

  it('reconciler refunds a genuinely orphaned PAID session and skips corrupt PAID sessions without user/unit', async () => {
    const { sweep } = require('../worker/reconciler');
    assert.equal(typeof sweep, 'function', 'reconciler must export sweep()');

    // 1. Genuinely orphaned PAID session (older than 30s, seat not sold)
    const orphanId = crypto.randomUUID();
    await redis.multi()
      .hset(config.payKey(orphanId), {
        user: 'alice',
        unit: '34',
        status: 'PAID',
        paidAt: String(Date.now() - 45000),
      })
      .pexpire(config.payKey(orphanId), config.PAID_SESSION_TTL_MS - 45000)
      .exec();

    // 2. Corrupt PAID session lacking user/unit (e.g. from a stray write)
    const corruptId = crypto.randomUUID();
    await redis.multi()
      .hset(config.payKey(corruptId), {
        status: 'PAID',
        paidAt: String(Date.now() - 45000),
      })
      .pexpire(config.payKey(corruptId), config.PAID_SESSION_TTL_MS - 45000)
      .exec();

    const { refunded } = await sweep();
    assert.equal(refunded, 1);

    const orphanAfter = await redis.hgetall(config.payKey(orphanId));
    assert.equal(orphanAfter.status, 'REFUND');

    const corruptAfter = await redis.hgetall(config.payKey(corruptId));
    assert.equal(corruptAfter.status, 'PAID', 'corrupt session without user/unit must not be refunded');
  });

  it('when session vanishes during gateway call (pay_finish returns 0), still confirms seat and does not create partial session', async () => {
    const { setGateway } = require('../src/services/payment');
    const { sweep } = require('../worker/reconciler');
    const unit = 35;
    const bookingId = crypto.randomUUID();

    await srv.request('POST', '/hold', {
      headers: { 'x-user-id': 'alice' },
      body: { unit },
    });
    await srv.request('POST', '/checkout', {
      headers: { 'x-user-id': 'alice' },
      body: { unit, bookingId },
    });

    // Inject gateway that deletes the session key mid-flight (simulating session expiry during slow gateway)
    setGateway(async ({ idempotencyKey }) => {
      assert.equal(idempotencyKey, bookingId);
      await redis.del(config.payKey(bookingId));
      return true;
    });

    let payRes;
    try {
      payRes = await srv.request('POST', '/pay', {
        headers: { 'x-user-id': 'alice' },
        body: { bookingId },
      });
    } finally {
      setGateway(null);
    }

    assert.equal(payRes.status, 200);
    assert.equal(payRes.json.status, 'BOOKED');
    assert.equal(await redis.hget(config.soldKey(), String(unit)), bookingId);
    assert.equal(await redis.exists(config.payKey(bookingId)), 0, 'pay_finish must not recreate expired session key');

    const { refunded } = await sweep();
    assert.equal(refunded, 0);
  });
});
