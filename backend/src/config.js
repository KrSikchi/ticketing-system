// Central configuration: loads .env (from the project root, regardless of cwd), parses numbers and
// booleans, validates the dangerous ones, and exports ONE frozen object. Also exports the Redis
// key builders so every process (API, workers, scripts, tests) spells keys exactly the same way.
'use strict';

const path = require('path');
const dotenv = require('dotenv');

// Values already present in process.env win over .env (that is how start-all.js sets PORT / WORKER_ID).
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

/** Read an integer/float env var with a default; throws on garbage so misconfiguration fails fast. */
function num(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Config error: ${name}="${raw}" is not a number`);
  return n;
}

/** Read a boolean env var ("true"/"1"/"yes"/"on" are truthy). */
function bool(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

/** Read a string env var with a default. */
function str(name, def) {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? def : raw;
}

const EVENT_ID = str('EVENT_ID', 'e1');

const config = Object.freeze({
  PORT: num('PORT', 3001),
  REDIS_URL: str('REDIS_URL', 'redis://127.0.0.1:6379'),
  DATABASE_URL: str('DATABASE_URL', 'postgres://postgres:pass@localhost:5432/tickets'),

  EVENT_ID,
  TOTAL_UNITS: num('TOTAL_UNITS', 200),

  HOLD_TTL_MS: num('HOLD_TTL_MS', 90000),
  MAX_HOLDS_PER_USER: num('MAX_HOLDS_PER_USER', 4),
  MAX_HOLD_TOTAL_MS: num('MAX_HOLD_TOTAL_MS', 180000),
  PAY_SESSION_TTL_MS: num('PAY_SESSION_TTL_MS', 90000),
  PAID_SESSION_TTL_MS: num('PAID_SESSION_TTL_MS', 3600000),

  PAYMENT_DELAY_MS: num('PAYMENT_DELAY_MS', 100),
  PAYMENT_FAIL_RATE: num('PAYMENT_FAIL_RATE', 0),
  PAYMENT_TIMEOUT_MS: num('PAYMENT_TIMEOUT_MS', 15000),

  AUTH_MODE: str('AUTH_MODE', 'header'),
  JWT_SECRET: str('JWT_SECRET', ''),
  TRUST_PROXY: bool('TRUST_PROXY', false),

  RATE_LIMIT_ENABLED: bool('RATE_LIMIT_ENABLED', true),
  BUCKET_CAPACITY: num('BUCKET_CAPACITY', 20),
  BUCKET_REFILL_PER_SEC: num('BUCKET_REFILL_PER_SEC', 10),
  IP_BUCKET_CAPACITY: num('IP_BUCKET_CAPACITY', 15000),
  IP_BUCKET_REFILL_PER_SEC: num('IP_BUCKET_REFILL_PER_SEC', 5000),

  WORKER_ID: str('WORKER_ID', 'w1'),

  // ---- Redis key builders -------------------------------------------------------------------
  // The {EVENT_ID} braces are a Redis Cluster hash-tag: every key of one event hashes to the same
  // slot, so the multi-key Lua scripts keep working if this is ever moved to Redis Cluster.
  /** Per-seat hold key. Value = userId holding the seat, TTL = HOLD_TTL_MS. */
  holdKey: (unit) => `evt:{${EVENT_ID}}:hold:${unit}`,
  /** Per-seat max total hold duration key (NX, PX = MAX_HOLD_TOTAL_MS). */
  holdMaxKey: (unit) => `evt:{${EVENT_ID}}:holdmax:${unit}`,
  /** Per-user ZSET of held units scored by hold expiry timestamp (ms). */
  userHoldsKey: (userId) => `evt:{${EVENT_ID}}:uholds:${userId}`,
  /** Hash of sold seats: field = unit, value = bookingId. */
  soldKey: () => `evt:{${EVENT_ID}}:sold`,
  /** Readiness gate key set by rehydrate() after restoring sold seats from Postgres. */
  readyKey: () => `evt:{${EVENT_ID}}:ready`,
  /** Mock payment session hash for one bookingId (hash-tagged with {EVENT_ID} for cluster slot co-location). */
  payKey: (id) => `pay:{${EVENT_ID}}:${id}`,
  /** Per-user token bucket for the rate limiter. */
  rlKey: (userId) => `rl:${userId}`,
  /** Per-IP token bucket for the rate limiter. */
  ipRlKey: (ip) => `rl:ip:${ip}`,
  /** Redis Stream that carries confirmed bookings to the persist workers. */
  streamKey: 'bookings',
  /** Consumer group name on the stream. */
  group: 'persisters',
  /** Pub/Sub channel for live seat-state events (consumed by socket.js). */
  channel: 'seat-events',
});

// ---- Sanity checks: fail fast at boot instead of misbehaving under load ----------------------
if (!Number.isInteger(config.TOTAL_UNITS) || config.TOTAL_UNITS < 1) {
  throw new Error('Config error: TOTAL_UNITS must be a positive integer');
}
if (config.PAYMENT_FAIL_RATE < 0 || config.PAYMENT_FAIL_RATE > 1) {
  throw new Error('Config error: PAYMENT_FAIL_RATE must be between 0 and 1');
}
if (config.HOLD_TTL_MS < 1 || config.MAX_HOLD_TOTAL_MS < 1 || config.PAY_SESSION_TTL_MS < 1 || config.PAID_SESSION_TTL_MS < 1 || config.PAYMENT_TIMEOUT_MS < 1) {
  throw new Error('Config error: TTL values must be positive milliseconds');
}
if (!Number.isInteger(config.MAX_HOLDS_PER_USER) || config.MAX_HOLDS_PER_USER < 1) {
  throw new Error('Config error: MAX_HOLDS_PER_USER must be a positive integer');
}
if (!['header', 'jwt'].includes(config.AUTH_MODE)) {
  throw new Error('Config error: AUTH_MODE must be "header" or "jwt"');
}
if (config.AUTH_MODE === 'jwt' && !config.JWT_SECRET) {
  throw new Error('Config error: JWT_SECRET is required when AUTH_MODE=jwt');
}

module.exports = config;
