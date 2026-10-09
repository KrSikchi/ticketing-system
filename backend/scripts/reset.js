// Reset everything to "200 free seats": deletes the event's Redis keys (holds, sold hash), payment
// sessions, rate-limit buckets and the bookings stream (SCAN, never KEYS), truncates the Postgres
// tables, (re)applies db/schema.sql idempotently and recreates the consumer group.
// Safe to run while start-all is up: the workers recover from the recreated group automatically.
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../src/config');
const { redis, waitUntilReady } = require('../src/redis');
const { pool, waitForPostgres } = require('../src/pg');

/** Delete every key matching `pattern` using SCAN (safe on a busy Redis). Returns the count. */
async function scanDelete(pattern) {
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    if (keys.length) deleted += await redis.del(...keys);
  } while (cursor !== '0');
  return deleted;
}

async function main() {
  console.log('[reset] waiting for Redis and Postgres...');
  await waitUntilReady(redis);
  await waitForPostgres({ maxWaitMs: 60000 });

  // ---- Postgres first: if this fails nothing in Redis has been touched yet, so Redis and
  // Postgres can never end up disagreeing because of a half-finished reset. ----
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(schema); // CREATE TABLE IF NOT EXISTS -> idempotent
  await pool.query('TRUNCATE bookings, dead_letters RESTART IDENTITY');
  console.log('[reset] truncated bookings and dead_letters (identities restarted)');

  // ---- Redis ----
  const evtDeleted = await scanDelete(`evt:{${config.EVENT_ID}}:*`);
  const payDeleted = await scanDelete(config.payKey('*'));
  const rlDeleted = await scanDelete(config.rlKey('*'));
  const streamDeleted = await redis.del(config.streamKey);
  try {
    await redis.xgroup('CREATE', config.streamKey, config.group, '0', 'MKSTREAM');
  } catch (err) {
    // A running persist worker may have recreated the group a millisecond before us - that is fine.
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  }

  console.log(`[reset] cleared ${evtDeleted} event keys (holds + sold hash) for event ${config.EVENT_ID}`);
  console.log(`[reset] cleared ${payDeleted} payment sessions, ${rlDeleted} rate-limit buckets`);
  console.log(`[reset] ${streamDeleted ? 'deleted' : 'no'} "${config.streamKey}" stream; consumer group "${config.group}" ready`);
  console.log(`[reset] done - ${config.TOTAL_UNITS} seats free`);
}

main()
  .then(() => Promise.all([redis.quit(), pool.end()]))
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`[reset] failed: ${err.message}`);
    process.exit(1);
  });
