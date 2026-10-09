// Reconciler: every 30 s it SCANs payment sessions (pay:*) and refunds any session that is PAID
// for more than ~30 s while its seat is NOT sold to that bookingId (e.g. the API died between
// pay() and confirm, or the hold expired before confirm). "Refund" is a mock: status -> REFUND.
// Ages are derived from the key's TTL, i.e. from Redis's clock - never from this host's clock.
'use strict';

const config = require('../src/config');
const { redis, waitUntilReady } = require('../src/redis');

const TAG = '[reconciler]';
const SWEEP_EVERY_MS = 30000;
const MIN_PAID_AGE_MS = 30000; // grace period so an in-flight confirm is never raced
const SCAN_COUNT = 200;

/** One pass over all pay:* keys. Returns { scanned, refunded }. */
async function sweep() {
  let cursor = '0';
  let scanned = 0;
  let refunded = 0;

  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', config.payKey('*'), 'COUNT', SCAN_COUNT);
    cursor = next;
    if (keys.length === 0) continue;

    // Fetch the status of all keys in this page with one pipeline.
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.hgetall(key).pttl(key);
    const results = await pipeline.exec();

    for (let i = 0; i < keys.length; i++) {
      const [sessionErr, session] = results[i * 2];
      const [ttlErr, pttl] = results[i * 2 + 1];
      if (sessionErr || ttlErr || !session || !session.status) continue;
      scanned += 1;
      if (session.status !== 'PAID') continue;

      if (!session.user || !session.unit) {
        console.error(`${TAG} ALERT: PAID session ${keys[i]} lacks user or unit (${JSON.stringify(session)}); skipping refund`);
        continue;
      }

      // pay() sets PEXPIRE PAID_SESSION_TTL_MS at the moment of payment, so the elapsed time
      // since payment (by Redis's clock) is PAID_SESSION_TTL_MS - PTTL.
      const ageMs = config.PAID_SESSION_TTL_MS - pttl;
      if (pttl < 0 || ageMs < MIN_PAID_AGE_MS) continue;

      const bookingId = keys[i].slice(config.payKey('').length);
      const soldTo = await redis.hget(config.soldKey(), String(session.unit));
      if (soldTo === bookingId) continue; // all good: paid AND owns the seat

      const updated = await redis.pay_finish(keys[i], 'REFUND', String(config.PAID_SESSION_TTL_MS), '');
      if (Number(updated) === 1) {
        refunded += 1;
        console.log(`refunded ${bookingId} (user ${session.user}, unit ${session.unit} is ${soldTo ? `sold to ${soldTo}` : 'not sold'})`);
      }
    }
  } while (cursor !== '0');

  return { scanned, refunded };
}

let running = false;
async function tick() {
  if (running) return; // never overlap two sweeps
  running = true;
  try {
    const { scanned, refunded } = await sweep();
    console.log(`${TAG} sweep done: ${scanned} sessions scanned, ${refunded} refunded`);
  } catch (err) {
    console.error(`${TAG} sweep failed: ${err.message}`);
  } finally {
    running = false;
  }
}

async function main() {
  console.log(`${TAG} starting (every ${SWEEP_EVERY_MS / 1000} s, refund PAID sessions older than ${MIN_PAID_AGE_MS / 1000} s without a seat)`);
  await waitUntilReady(redis);
  const timer = setInterval(tick, SWEEP_EVERY_MS);
  await tick();

  const shutdown = async (signal) => {
    console.log(`${TAG} ${signal} received, exiting`);
    clearInterval(timer);
    await redis.quit().catch(() => redis.disconnect());
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  console.error(`${TAG} unhandled rejection:`, reason && reason.stack ? reason.stack : reason);
});

if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = { sweep, tick };
