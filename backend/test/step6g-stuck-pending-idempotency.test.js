'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { config, redis, cleanRedis } = require('./helpers');
const { holdSeat } = require('../src/services/inventory');
const { createSession, pay, setGateway } = require('../src/services/payment');
const reconciler = require('../worker/reconciler');

describe('Step 6g: Gateway idempotency key and reconciler flagging of stuck PENDING sessions', () => {
  beforeEach(async () => {
    await cleanRedis();
    setGateway(null);
  });

  afterEach(() => {
    setGateway(null);
  });

  it('passes bookingId as idempotencyKey to the payment gateway and records lockedAt on pay_begin', async () => {
    const unit = 61;
    const bookingId = crypto.randomUUID();
    await holdSeat(unit, 'alice');
    await createSession('alice', unit, bookingId);

    let receivedArgs = null;
    let sessionDuringCall = null;
    setGateway(async (args) => {
      receivedArgs = args;
      sessionDuringCall = await redis.hgetall(config.payKey(bookingId));
      return true;
    });

    const res = await pay(bookingId, 'alice');
    assert.equal(res.status, 'PAID');
    assert.ok(receivedArgs, 'gateway should have been called');
    assert.equal(receivedArgs.idempotencyKey, bookingId, 'gateway must receive bookingId as idempotencyKey');
    assert.equal(sessionDuringCall.lock, '1');
    assert.ok(sessionDuringCall.lockedAt, 'pay_begin must record lockedAt timestamp from Redis TIME');
  });

  it('reconciler flags PENDING sessions whose lock has been held longer than STUCK_LOCK_MS without a final status', async () => {
    assert.equal(typeof config.STUCK_LOCK_MS, 'number', 'config.STUCK_LOCK_MS must be defined');

    const stuckBookingId = crypto.randomUUID();
    const freshBookingId = crypto.randomUUID();
    const [sec, usec] = await redis.time();
    const nowMs = Number(sec) * 1000 + Math.floor(Number(usec) / 1000);

    // 1. Stuck PENDING session: lock held for 20s (> 15s default STUCK_LOCK_MS)
    const stuckKey = config.payKey(stuckBookingId);
    await redis.hset(
      stuckKey,
      'user', 'alice',
      'unit', '62',
      'status', 'PENDING',
      'lock', '1',
      'lockedAt', String(nowMs - 20000)
    );
    await redis.pexpire(stuckKey, 60000);

    // 2. Fresh in-flight PENDING session: lock held for 100ms (< STUCK_LOCK_MS)
    const freshKey = config.payKey(freshBookingId);
    await redis.hset(
      freshKey,
      'user', 'bob',
      'unit', '63',
      'status', 'PENDING',
      'lock', '1',
      'lockedAt', String(nowMs - 100)
    );
    await redis.pexpire(freshKey, 60000);

    const alerts = [];
    const origError = console.error;
    console.error = (...args) => {
      alerts.push(args.join(' '));
      origError(...args);
    };

    let result;
    try {
      result = await reconciler.sweep();
    } finally {
      console.error = origError;
    }

    assert.equal(result.stuck, 1, 'reconciler sweep must report 1 stuck PENDING session');
    assert.ok(
      alerts.some((a) => a.includes('ALERT') && a.includes(stuckBookingId)),
      'reconciler must log an ALERT for the stuck PENDING session'
    );
    assert.ok(
      !alerts.some((a) => a.includes(freshBookingId)),
      'reconciler must NOT flag a fresh in-flight PENDING session'
    );

    const stuckSession = await redis.hgetall(stuckKey);
    assert.equal(stuckSession.flagged, 'STUCK_PENDING');
    const pttl = await redis.pttl(stuckKey);
    assert.ok(pttl > 0, 'flagged session must retain a positive TTL');
  });
});
