'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { cleanRedis, startTestServer } = require('./helpers');

describe('Step 2 (Finding 4): Replayed /pay after FAILED must not release a newer hold', () => {
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

  it('preserves a newer hold when an old FAILED /pay is replayed, while keeping PAID replay idempotent', async () => {
    const unit = 20;
    const oldBookingId = crypto.randomUUID();

    // 1. Alice holds seat 20 and creates a checkout session
    const hold1 = await srv.request('POST', '/hold', {
      headers: { 'x-user-id': 'alice' },
      body: { unit },
    });
    assert.equal(hold1.status, 200);

    const co1 = await srv.request('POST', '/checkout', {
      headers: { 'x-user-id': 'alice' },
      body: { unit, bookingId: oldBookingId },
    });
    assert.equal(co1.status, 200);

    // 2. Force the payment to fail
    const origRandom = Math.random;
    Math.random = () => -1;
    let pay1;
    try {
      pay1 = await srv.request('POST', '/pay', {
        headers: { 'x-user-id': 'alice' },
        body: { bookingId: oldBookingId },
      });
    } finally {
      Math.random = origRandom;
    }
    assert.equal(pay1.status, 402);
    assert.equal(pay1.json.reason, 'PAYMENT_FAILED');

    // 3. Alice re-holds seat 20
    const hold2 = await srv.request('POST', '/hold', {
      headers: { 'x-user-id': 'alice' },
      body: { unit },
    });
    assert.equal(hold2.status, 200);

    // 4. Replay the old failed /pay -> still 402 PAYMENT_FAILED, but must NOT delete Alice's new hold
    const replay = await srv.request('POST', '/pay', {
      headers: { 'x-user-id': 'alice' },
      body: { bookingId: oldBookingId },
    });
    assert.equal(replay.status, 402);
    assert.equal(replay.json.reason, 'PAYMENT_FAILED');

    // 5. Bob tries to hold seat 20 -> must get 409 HELD because Alice's new hold survived
    const bobHold = await srv.request('POST', '/hold', {
      headers: { 'x-user-id': 'bob' },
      body: { unit },
    });
    assert.equal(bobHold.status, 409);
    assert.equal(bobHold.json.reason, 'HELD');

    // 6. Alice completes booking with a new bookingId, and replaying PAID /pay stays idempotent
    const newBookingId = crypto.randomUUID();
    const co2 = await srv.request('POST', '/checkout', {
      headers: { 'x-user-id': 'alice' },
      body: { unit, bookingId: newBookingId },
    });
    assert.equal(co2.status, 200);

    const pay2 = await srv.request('POST', '/pay', {
      headers: { 'x-user-id': 'alice' },
      body: { bookingId: newBookingId },
    });
    assert.equal(pay2.status, 200);
    assert.equal(pay2.json.status, 'BOOKED');

    const pay2Replay = await srv.request('POST', '/pay', {
      headers: { 'x-user-id': 'alice' },
      body: { bookingId: newBookingId },
    });
    assert.equal(pay2Replay.status, 200);
    assert.equal(pay2Replay.json.status, 'BOOKED');
  });
});
