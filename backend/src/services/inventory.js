// Seat inventory service: atomic decisions live in Redis Lua; this module publishes events and reads seat maps.
'use strict';

const config = require('../config');
const { redis } = require('../redis');

let cachedSeatMap = null;
let cachedSeatMapAt = 0;
let seatMapInflight = null;

function invalidateSeatMapCache() {
  cachedSeatMap = null;
  cachedSeatMapAt = 0;
  seatMapInflight = null;
}

/** Fire-and-forget ordered Pub/Sub notification. Publishing never changes a booking result. */
function publish(unit, state) {
  invalidateSeatMapCache();
  try {
    redis.incr(config.seqKey())
      .then((seq) => redis.publish(config.channel, JSON.stringify({ unit, state, seq: Number(seq), ts: Date.now() })))
      .catch(() => {});
  } catch (_) {
    /* best effort only */
  }
}

/** Try to hold a seat, optionally binding it to a booking ID. */
async function holdSeat(unit, userId, bookingId = '') {
  const status = await redis.hold(
    config.soldKey(),
    config.holdKey(unit),
    config.readyKey(),
    config.userHoldsKey(userId),
    config.holdMaxKey(unit),
    String(unit),
    userId,
    String(Number(process.env.HOLD_TTL_MS || config.HOLD_TTL_MS)),
    String(Number(process.env.MAX_HOLDS_PER_USER || config.MAX_HOLDS_PER_USER)),
    String(Number(process.env.MAX_HOLD_TOTAL_MS || config.MAX_HOLD_TOTAL_MS)),
    bookingId,
  );
  if (status === 'OK') publish(unit, 'held');
  return status;
}

/** Release only a hold owned by this user and, when supplied, this booking. */
async function releaseSeat(unit, userId, bookingId = '') {
  const released = await redis.release(
    config.holdKey(unit),
    config.userHoldsKey(userId),
    config.holdMaxKey(unit),
    userId,
    bookingId,
    String(unit),
  );
  if (released === 1) publish(unit, 'free');
  return released === 1;
}

/** Convert a valid hold into a permanent sale and enqueue the booking atomically. */
async function confirmSeat(unit, userId, bookingId) {
  const status = await redis.confirm(
    config.soldKey(),
    config.holdKey(unit),
    config.streamKey,
    config.userHoldsKey(userId),
    config.holdMaxKey(unit),
    config.readyKey(),
    String(unit),
    userId,
    bookingId,
    config.EVENT_ID,
  );
  if (status === 'OK') publish(unit, 'sold');
  return status;
}

async function fetchSeatMapFromRedis() {
  const holdKeys = [];
  for (let unit = 1; unit <= config.TOTAL_UNITS; unit++) holdKeys.push(config.holdKey(unit));

  const results = await redis.pipeline()
    .hgetall(config.soldKey())
    .mget(holdKeys)
    .get(config.seqKey())
    .exec();
  const [[soldErr, sold], [holdErr, holds], [seqErr, rawSeq]] = results;
  if (soldErr) throw soldErr;
  if (holdErr) throw holdErr;
  if (seqErr) throw seqErr;

  const seats = [];
  for (let unit = 1; unit <= config.TOTAL_UNITS; unit++) {
    let state = 'free';
    if (sold && sold[String(unit)]) state = 'sold';
    else if (holds[unit - 1]) state = 'held';
    seats.push({ unit, state });
  }
  Object.defineProperty(seats, 'seq', {
    value: rawSeq ? Number(rawSeq) : 0,
    enumerable: false,
    configurable: true,
  });
  return seats;
}

/** Cached short-lived snapshot with a single shared Redis read for concurrent callers. */
async function getSeatMap() {
  const ttl = config.SEATMAP_CACHE_MS;
  const now = Date.now();
  if (ttl > 0 && cachedSeatMap && now - cachedSeatMapAt < ttl) return cachedSeatMap;
  if (seatMapInflight) return seatMapInflight;

  seatMapInflight = fetchSeatMapFromRedis()
    .then((seats) => {
      cachedSeatMap = seats;
      cachedSeatMapAt = Date.now();
      seatMapInflight = null;
      return seats;
    })
    .catch((err) => {
      seatMapInflight = null;
      throw err;
    });
  return seatMapInflight;
}

module.exports = { holdSeat, releaseSeat, confirmSeat, getSeatMap, publish, invalidateSeatMapCache };