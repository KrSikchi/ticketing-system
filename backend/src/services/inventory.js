// Seat inventory service: the ONLY place that touches hold keys / the sold hash.
// Every decision (hold, confirm, release) is a single atomic Lua call in Redis; this module just
// passes arguments, publishes best-effort live events and builds the seat map for GET /seats.
'use strict';

const config = require('../config');
const { redis } = require('../redis');

/** Fire-and-forget Pub/Sub notification with timestamp for sequence ordering. */
function publish(unit, state) {
  try {
    redis.publish(config.channel, JSON.stringify({ unit, state, ts: Date.now() })).catch(() => {});
  } catch (_) {
    /* best effort only */
  }
}

/**
 * Try to hold a seat for a user for HOLD_TTL_MS. Returns 'OK' | 'SOLD' | 'HELD' | 'NOT_READY'.
 * Re-holding your own seat refreshes the TTL (same user -> 'OK').
 */
async function holdSeat(unit, userId, bookingId = '') {
  const status = await redis.hold(
    config.readyKey(),
    config.soldKey(),
    config.holdKey(unit),
    unit,
    userId,
    config.HOLD_TTL_MS,
    bookingId || '',
  );
  if (status === 'OK') publish(unit, 'held');
  return status;
}

/** Release a hold if (and only if) this user owns it for this booking. Returns true when removed. */
async function releaseSeat(unit, userId, bookingId = '') {
  const released = await redis.release(config.holdKey(unit), userId, bookingId || '');
  if (released === 1) publish(unit, 'free');
  return released === 1;
}

/**
 * Turn a valid hold into a permanent sale and enqueue the booking for Postgres.
 * Returns 'OK' | 'SOLD' | 'EXPIRED' | 'NOT_READY' (idempotent: confirming the same bookingId twice is 'OK').
 */
async function confirmSeat(unit, userId, bookingId) {
  const status = await redis.confirm(
    config.readyKey(),
    config.soldKey(),
    config.holdKey(unit),
    config.streamKey,
    unit,
    userId,
    bookingId,
    config.EVENT_ID,
  );
  if (status === 'OK') publish(unit, 'sold');
  return status;
}

/**
 * Snapshot of every seat: [{ unit, state: 'sold' | 'held' | 'free' }].
 * One pipeline round-trip: HGETALL sold + MGET of all hold keys.
 */
async function getSeatMap() {
  const holdKeys = [];
  for (let unit = 1; unit <= config.TOTAL_UNITS; unit++) holdKeys.push(config.holdKey(unit));

  const results = await redis.pipeline().hgetall(config.soldKey()).mget(holdKeys).exec();
  // pipeline.exec() resolves with [err, value] pairs - surface the first error (e.g. Redis down -> 503).
  const [[soldErr, sold], [holdErr, holds]] = results;
  if (soldErr) throw soldErr;
  if (holdErr) throw holdErr;

  const seats = [];
  for (let unit = 1; unit <= config.TOTAL_UNITS; unit++) {
    let state = 'free';
    if (sold && sold[String(unit)]) state = 'sold'; // sold wins over any stale hold
    else if (holds[unit - 1]) state = 'held';
    seats.push({ unit, state });
  }
  return seats;
}

module.exports = { holdSeat, releaseSeat, confirmSeat, getSeatMap, publish };
