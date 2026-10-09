// Rebuild Redis's sold hash from Postgres (the durable source of truth for sold seats).
// Runs at API startup and on every Redis 'ready' (i.e. after each reconnect), so a Redis that lost
// its data can never re-sell a seat. Uses HSETNX so it is idempotent and never overwrites a sale
// that Redis knows about but Postgres has not persisted yet.
'use strict';

const config = require('./config');
const { redis } = require('./redis');
const { pool } = require('./pg');

async function rehydrate() {
  const { rows } = await pool.query(
    'SELECT unit_id, booking_id FROM bookings WHERE event_id = $1',
    [config.EVENT_ID],
  );

  let restored = 0;
  if (rows.length > 0) {
    const pipeline = redis.pipeline();
    for (const row of rows) pipeline.hsetnx(config.soldKey(), String(row.unit_id), row.booking_id);
    const results = await pipeline.exec();
    for (const [err, added] of results) {
      if (err) throw err;
      if (added === 1) restored += 1;
    }
  }

  // Only after the Postgres read and HSETNX pipeline succeed do we mark the event ready (no TTL).
  await redis.set(config.readyKey(), '1');

  console.log(`[rehydrate] event ${config.EVENT_ID}: ${rows.length} sold seats in Postgres, ${restored} restored into Redis`);
  return restored;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let activeLoop = null;
let rerunRequested = false;

/**
 * Run rehydrate() on Redis reconnect with retry + exponential backoff (capped at ~5s) until
 * success. Never overlaps two rehydrate loops. Best-effort deletes readyKey before rehydrating.
 */
function rehydrateWithRetry({ baseDelayMs = 200, maxDelayMs = 5000, shouldStop = () => false, tag = '[rehydrate]' } = {}) {
  if (activeLoop) {
    rerunRequested = true;
    redis.del(config.readyKey()).catch(() => {});
    return activeLoop;
  }
  activeLoop = (async () => {
    try {
      do {
        rerunRequested = false;
        await redis.del(config.readyKey()).catch(() => {});
        let attempt = 0;
        for (;;) {
          if (shouldStop()) return;
          try {
            await rehydrate();
            break;
          } catch (err) {
            if (shouldStop()) return;
            const delay = Math.min(baseDelayMs * (2 ** attempt), maxDelayMs);
            attempt += 1;
            console.error(`${tag} rehydrate after reconnect failed: ${err.message} (retrying in ${delay} ms)`);
            await sleep(delay);
          }
        }
      } while (rerunRequested && !shouldStop());
    } finally {
      activeLoop = null;
    }
  })();
  return activeLoop;
}

rehydrate.rehydrateWithRetry = rehydrateWithRetry;
module.exports = rehydrate;
