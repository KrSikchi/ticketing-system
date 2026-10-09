'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { cleanRedis, startTestServer, teardownConnections } = require('./helpers');

describe('Step 1 (Finding 6): Retrying /book with the same bookingId', () => {
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

  it('returns 200 BOOKED twice when the seat owner retries /book with the same bookingId', async () => {
    const bookingId = crypto.randomUUID();
    const first = await srv.request('POST', '/book', {
      headers: { 'x-user-id': 'alice' },
      body: { unit: 10, bookingId },
    });
    assert.equal(first.status, 200);
    assert.equal(first.json.status, 'BOOKED');
    assert.equal(first.json.bookingId, bookingId);
    assert.equal(first.json.unit, 10);

    // Retry with the same bookingId and same user
    const second = await srv.request('POST', '/book', {
      headers: { 'x-user-id': 'alice' },
      body: { unit: 10, bookingId },
    });
    assert.equal(second.status, 200);
    assert.equal(second.json.status, 'BOOKED');
    assert.equal(second.json.bookingId, bookingId);
    assert.equal(second.json.unit, 10);
  });

  it('returns 409 BOOKING_ID_CONFLICT when a different user reuses that bookingId', async () => {
    const bookingId = crypto.randomUUID();
    const first = await srv.request('POST', '/book', {
      headers: { 'x-user-id': 'alice' },
      body: { unit: 11, bookingId },
    });
    assert.equal(first.status, 200);

    const conflict = await srv.request('POST', '/book', {
      headers: { 'x-user-id': 'bob' },
      body: { unit: 11, bookingId },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.reason, 'BOOKING_ID_CONFLICT');
  });

  it('still returns 409 SOLD when a different user books the sold seat with a new bookingId', async () => {
    const bookingId1 = crypto.randomUUID();
    const first = await srv.request('POST', '/book', {
      headers: { 'x-user-id': 'alice' },
      body: { unit: 12, bookingId: bookingId1 },
    });
    assert.equal(first.status, 200);

    const sold = await srv.request('POST', '/book', {
      headers: { 'x-user-id': 'bob' },
      body: { unit: 12, bookingId: crypto.randomUUID() },
    });
    assert.equal(sold.status, 409);
    assert.equal(sold.json.reason, 'SOLD');
  });
});
