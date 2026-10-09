'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config, redis, pool, cleanRedis } = require('./helpers');
const persist = require('../worker/persist');

describe('Step 6f: Dead-letter schema columns and automatic Redis/payment reconciliation', () => {
  beforeEach(async () => {
    await cleanRedis();
    await pool.query('DELETE FROM bookings WHERE event_id = $1', [config.EVENT_ID]);
    await pool.query('TRUNCATE dead_letters RESTART IDENTITY');
  });

  it('defines status and resolved_at via ADD COLUMN IF NOT EXISTS in db/schema.sql', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    assert.match(schema, /ADD COLUMN IF NOT EXISTS\s+status/i);
    assert.match(schema, /ADD COLUMN IF NOT EXISTS\s+resolved_at/i);
  });

  it('on 23505 dead-letter: restores winning bookingId in Redis sold hash, marks loser session REFUND (guarded), updates dead_letters status/resolved_at, and logs structured alert', async () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await pool.query(schema);

    const unit = 55;
    const winnerBookingId = crypto.randomUUID();
    const loserBookingId = crypto.randomUUID();

    // 1. Winner is already committed in Postgres for (EVENT_ID, unit 55)
    await pool.query(
      'INSERT INTO bookings (booking_id, event_id, unit_id, user_id) VALUES ($1, $2, $3, $4)',
      [winnerBookingId, config.EVENT_ID, unit, 'winner-user']
    );

    // 2. Simulate split-brain where Redis sold hash has loserBookingId and loser has a PAID session
    await redis.hset(config.soldKey(), String(unit), loserBookingId);
    await redis.hset(
      config.payKey(loserBookingId),
      'user', 'loser-user',
      'unit', String(unit),
      'status', 'PAID',
      'paidAt', String(Date.now())
    );
    await redis.pexpire(config.payKey(loserBookingId), 60000);

    // 3. Capture console.error to verify structured alert
    const errors = [];
    const origError = console.error;
    console.error = (...args) => {
      errors.push(args.join(' '));
      origError(...args);
    };

    try {
      const outcome = await persist.writeToPostgres('1700000000000-0', {
        bookingId: loserBookingId,
        event: config.EVENT_ID,
        unit: String(unit),
        user: 'loser-user',
      });
      assert.equal(outcome, 'dead-lettered');
    } finally {
      console.error = origError;
    }

    // 4. Redis sold hash must now hold Postgres's winning bookingId
    const soldOwner = await redis.hget(config.soldKey(), String(unit));
    assert.equal(soldOwner, winnerBookingId, 'persist must restore Postgres winning bookingId into Redis sold hash');

    // 5. Loser's payment session must be marked REFUND with a positive TTL
    const loserSession = await redis.hgetall(config.payKey(loserBookingId));
    assert.equal(loserSession.status, 'REFUND', 'loser payment session must be marked REFUND');
    const ttl = await redis.pttl(config.payKey(loserBookingId));
    assert.ok(ttl > 0, 'loser payment session must retain a positive TTL');

    // 6. dead_letters row must have status = RESOLVED and resolved_at set
    const { rows } = await pool.query('SELECT status, resolved_at, payload, reason FROM dead_letters');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'RESOLVED');
    assert.ok(rows[0].resolved_at, 'resolved_at must be populated');

    // 7. Structured alert must have been logged
    assert.ok(
      errors.some((line) => line.includes('DEAD_LETTER') && line.includes(loserBookingId) && line.includes(winnerBookingId)),
      'must log structured alert containing loser and winner bookingIds'
    );
  });
});
