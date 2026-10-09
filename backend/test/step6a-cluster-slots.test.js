'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config, redis, pool, cleanRedis } = require('./helpers');

const calcSlot = require('cluster-key-slot');

// Standard Redis Cluster CRC16 (XMODEM) slot calculation
function crc16(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function clusterKeySlot(key) {
  const s = String(key);
  const open = s.indexOf('{');
  if (open !== -1) {
    const close = s.indexOf('}', open + 1);
    if (close !== -1 && close > open + 1) {
      return crc16(Buffer.from(s.slice(open + 1, close))) % 16384;
    }
  }
  return crc16(Buffer.from(s)) % 16384;
}

describe('Step 6a: Redis Cluster hash-tag slot alignment and stream migration', () => {
  before(async () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await pool.query(schema);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM bookings WHERE event_id = $1', [config.EVENT_ID]);
    await cleanRedis();
  });

  after(async () => {
    await pool.query('DELETE FROM bookings WHERE event_id = $1', [config.EVENT_ID]).catch(() => {});
  });

  it('hashes every key used together in hold.lua, confirm.lua, release.lua, and pay_begin.lua to one CRC16 slot', async () => {
    assert.equal(config.streamKey, `evt:{${config.EVENT_ID}}:bookings`);

    const holdKeys = [
      config.soldKey(),
      config.holdKey(7),
      config.readyKey(),
      config.userHoldsKey('alice'),
      config.holdMaxKey(7),
    ];
    const confirmKeys = [
      config.soldKey(),
      config.holdKey(7),
      config.streamKey,
      config.userHoldsKey('alice'),
      config.holdMaxKey(7),
    ];
    const releaseKeys = [
      config.holdKey(7),
      config.userHoldsKey('alice'),
      config.holdMaxKey(7),
    ];
    const payBeginKeys = [
      config.soldKey(),
      config.holdKey(7),
      config.payKey(crypto.randomUUID()),
    ];

    const expectedSlot = calcSlot(config.soldKey());
    assert.equal(clusterKeySlot(config.soldKey()), expectedSlot);

    for (const [scriptName, keys] of [
      ['hold.lua', holdKeys],
      ['confirm.lua', confirmKeys],
      ['release.lua', releaseKeys],
      ['pay_begin.lua', payBeginKeys],
    ]) {
      for (const k of keys) {
        const slot = calcSlot(k);
        const manualSlot = clusterKeySlot(k);
        assert.equal(slot, expectedSlot, `${scriptName} key "${k}" slot ${slot} !== ${expectedSlot}`);
        assert.equal(manualSlot, expectedSlot, `${scriptName} manual CRC16 "${k}" ${manualSlot} !== ${expectedSlot}`);
      }
    }
  });

  it('persist worker creates consumer group on evt:{EVENT_ID}:bookings and drains legacy "bookings" stream', async () => {
    const persist = require('../worker/persist');
    assert.equal(typeof persist.ensureGroup, 'function');
    assert.equal(typeof persist.drainLegacyStream, 'function');

    await persist.ensureGroup();

    // Add an entry to legacy "bookings" stream and verify drainLegacyStream persists it to Postgres
    const legacyBookingId = crypto.randomUUID();
    await redis.xadd('bookings', '*', 'unit', '88', 'user', 'legacy-user', 'bookingId', legacyBookingId, 'event', config.EVENT_ID);

    const drained = await persist.drainLegacyStream();
    assert.equal(drained, 1);

    const { rows } = await pool.query('SELECT booking_id, unit_id, user_id FROM bookings WHERE booking_id = $1', [legacyBookingId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].unit_id, 88);
    assert.equal(rows[0].user_id, 'legacy-user');
  });
});
