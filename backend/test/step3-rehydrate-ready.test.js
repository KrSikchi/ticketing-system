'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { config, redis, pool, cleanRedis, startTestServer } = require('./helpers');
const { holdSeat } = require('../src/services/inventory');
const rehydrate = require('../src/rehydrate');

describe('Step 3 (Finding 2): Readiness gate and rehydrate after Redis data loss', () => {
  let srv;

  before(async () => {
    const fs = require('fs');
    const path = require('path');
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await pool.query(schema);
    srv = await startTestServer();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM bookings WHERE event_id = $1', [config.EVENT_ID]);
    await cleanRedis();
  });

  after(async () => {
    await pool.query('DELETE FROM bookings WHERE event_id = $1', [config.EVENT_ID]).catch(() => {});
    if (srv) await srv.close();
  });

  it('refuses holds with NOT_READY (HTTP 503 Retry-After: 1) after Redis wipe until rehydrate succeeds', async () => {
    // Simulate Redis data wipe (FLUSHALL)
    await redis.flushall();

    // Direct holdSeat returns NOT_READY
    const direct = await holdSeat(1, 'alice');
    assert.equal(direct, 'NOT_READY');

    // HTTP POST /hold returns 503 with Retry-After: 1
    const holdRes = await srv.request('POST', '/hold', {
      headers: { 'x-user-id': 'alice' },
      body: { unit: 1 },
    });
    assert.equal(holdRes.status, 503);
    assert.equal(holdRes.headers.get('retry-after'), '1');
    assert.equal(holdRes.json.reason, 'NOT_READY');

    // HTTP POST /book returns 503 with Retry-After: 1
    const bookRes = await srv.request('POST', '/book', {
      headers: { 'x-user-id': 'alice' },
      body: { unit: 1 },
    });
    assert.equal(bookRes.status, 503);
    assert.equal(bookRes.headers.get('retry-after'), '1');
    assert.equal(bookRes.json.reason, 'NOT_READY');

    // GET /health reports not-ready (503)
    const healthBefore = await srv.request('GET', '/health');
    assert.equal(healthBefore.status, 503);
    assert.equal(healthBefore.json.ready, false);

    // Run rehydrate -> sets readyKey -> hold succeeds
    await rehydrate();
    assert.equal(await redis.get(config.readyKey()), '1');
    assert.equal(await redis.ttl(config.readyKey()), -1); // no TTL

    const healthAfter = await srv.request('GET', '/health');
    assert.equal(healthAfter.status, 200);
    assert.equal(healthAfter.json.ready, true);

    const afterHold = await holdSeat(1, 'alice');
    assert.equal(afterHold, 'OK');
  });

  it('prevents double sale of a Postgres-sold seat after a Redis wipe', async () => {
    const soldBookingId = crypto.randomUUID();
    await pool.query(
      'INSERT INTO bookings (booking_id, event_id, unit_id, user_id) VALUES ($1, $2, $3, $4)',
      [soldBookingId, config.EVENT_ID, 42, 'alice'],
    );

    // Wipe Redis completely
    await redis.flushall();

    // Before rehydrate, Bob gets NOT_READY (cannot sneak in a hold while Redis is empty)
    assert.equal(await holdSeat(42, 'bob'), 'NOT_READY');

    // After rehydrate, seat 42 is restored as SOLD and Bob gets SOLD
    await rehydrate();
    assert.equal(await holdSeat(42, 'bob'), 'SOLD');

    // Free seat 43 can be held normally
    assert.equal(await holdSeat(43, 'bob'), 'OK');
  });

  it('leaves ready unset and keeps retrying with backoff when Postgres is unreachable', async () => {
    await redis.del(config.readyKey());

    let attempts = 0;
    const origQuery = pool.query.bind(pool);
    pool.query = async (...args) => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error('simulated postgres outage');
      }
      return origQuery(...args);
    };

    try {
      // First direct rehydrate() call fails and must NOT set readyKey
      await assert.rejects(() => rehydrate(), /simulated postgres outage/);
      assert.equal(await redis.exists(config.readyKey()), 0);
      assert.equal(await holdSeat(5, 'alice'), 'NOT_READY');

      // Reset attempts and test rehydrateWithRetry: fails twice, succeeds on 3rd try, overlapping call shares promise
      attempts = 0;
      const [p1, p2] = await Promise.all([
        rehydrate.rehydrateWithRetry({ baseDelayMs: 20, maxDelayMs: 100 }),
        rehydrate.rehydrateWithRetry({ baseDelayMs: 20, maxDelayMs: 100 }),
      ]);
      assert.equal(p1, p2);
      assert.ok(attempts >= 3, `expected at least 3 attempts, got ${attempts}`);
      assert.equal(await redis.get(config.readyKey()), '1');
      assert.equal(await holdSeat(5, 'alice'), 'OK');
    } finally {
      pool.query = origQuery;
    }
  });
});
