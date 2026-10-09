// Persist worker: moves confirmed bookings from the Redis Stream "bookings" into Postgres.
// Runs as a member of the "persisters" consumer group (start-all launches w1 and w2). Delivery is
// at-least-once (XACK only after a successful INSERT) and the INSERT is idempotent
// (ON CONFLICT (booking_id) DO NOTHING), so crashes and retries can never duplicate a row.
'use strict';

const config = require('../src/config');
const { redis, createRedis, waitUntilReady, isConnectionError } = require('../src/redis');
const { pool, waitForPostgres, describeError } = require('../src/pg');

const { streamKey: STREAM, group: GROUP, WORKER_ID } = config;
const TAG = `[persist-${WORKER_ID}]`;
const BATCH = 50;
const CLAIM_IDLE_MS = 5000;   // entries pending longer than this on ANY consumer get reclaimed
const BLOCK_MS = 2000;        // how long XREADGROUP waits for new entries
const RETRY_SLEEP_MS = 1000;  // pause when Postgres / Redis is unavailable

// Blocking reads need their own connection: a blocked connection cannot serve other commands.
const blocking = createRedis(`persist-${WORKER_ID}-blocking`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let stopping = false;

/** Create the consumer group if it does not exist yet (BUSYGROUP = already there, fine). */
async function ensureGroup() {
  try {
    await redis.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
    console.log(`${TAG} created consumer group ${GROUP} on stream ${STREAM}`);
  } catch (err) {
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  }
}

/** Convert a stream entry's flat [field, value, field, value, ...] array into an object. */
function fieldsToObject(fields) {
  const obj = {};
  for (let i = 0; i < fields.length; i += 2) obj[fields[i]] = fields[i + 1];
  return obj;
}

/** Acknowledge and delete a fully handled entry (one round-trip). */
async function ackAndDelete(id) {
  await redis.multi().xack(STREAM, GROUP, id).xdel(STREAM, id).exec();
}

/**
 * Postgres SQLSTATE classes 22 (data exception) and 23 (integrity constraint) mean the row itself is
 * unacceptable and retrying can never help -> dead-letter it. Everything else (connection refused,
 * admin shutdown, timeouts, ...) is treated as transient -> keep the entry pending and retry later.
 */
function isPoisonError(err) {
  const code = String(err.code || '');
  return code.startsWith('22') || code.startsWith('23');
}

/** Signals "Postgres is not usable right now"; the main loop then waits for it to come back. */
class PostgresUnavailable extends Error {
  constructor(cause) {
    super(describeError(cause));
    this.name = 'PostgresUnavailable';
  }
}

/**
 * Phase 1 of one entry: write it to Postgres (or to dead_letters if it can never be inserted).
 * Throws PostgresUnavailable on transient failures - nothing has been acked at that point.
 */
async function writeToPostgres(id, note) {
  try {
    await pool.query(
      `INSERT INTO bookings (booking_id, event_id, unit_id, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (booking_id) DO NOTHING`,
      [note.bookingId, note.event, Number(note.unit), note.user],
    );
    return 'persisted';
  } catch (err) {
    if (!isPoisonError(err)) throw new PostgresUnavailable(err);

    // A DIFFERENT bookingId already owns (event_id, unit_id) - or the payload is malformed.
    // This must never happen (Lua + the sold hash prevent it); it is a safety net, so shout.
    const reason = err.code === '23505'
      ? `unique violation on ${err.constraint || 'bookings'}: seat already sold to another booking`
      : `${err.code}: ${err.message}`;
    console.error(`${TAG} !!! DEAD LETTER ${id} (${reason}) payload=${JSON.stringify(note)}`);
    try {
      await pool.query(
        'INSERT INTO dead_letters (payload, reason) VALUES ($1, $2)',
        [JSON.stringify({ streamId: id, ...note }), reason],
      );
    } catch (dlErr) {
      throw new PostgresUnavailable(dlErr); // could not record it now -> entry stays pending
    }
    return 'dead-lettered';
  }
}

/** Handle ONE stream entry: Postgres first, then XACK + XDEL (Redis errors propagate to the loop). */
async function processEntry(id, fields) {
  const note = fieldsToObject(fields);
  const result = await writeToPostgres(id, note);
  await ackAndDelete(id);
  if (result === 'persisted') console.log(`persisted ${note.bookingId} unit ${note.unit} by ${WORKER_ID}`);
}

/** Process a list of [id, fields] entries in order; stops at the first transient failure. */
async function processEntries(entries) {
  for (const [id, fields] of entries) {
    if (stopping) return;
    await processEntry(id, fields);
  }
}

async function loop() {
  let lastErrorMessage = null;
  while (!stopping) {
    try {
      // a) Reclaim entries that another (dead or slow) consumer left pending for > CLAIM_IDLE_MS.
      //    Redis 7 returns [nextCursor, entries, deletedIds]; we only need the entries.
      const claimed = await redis.xautoclaim(STREAM, GROUP, WORKER_ID, CLAIM_IDLE_MS, '0', 'COUNT', BATCH);
      const claimedEntries = claimed && claimed[1] ? claimed[1] : [];
      if (claimedEntries.length) {
        console.log(`${TAG} reclaimed ${claimedEntries.length} pending entr${claimedEntries.length === 1 ? 'y' : 'ies'}`);
        await processEntries(claimedEntries);
      }
      if (stopping) break;

      // b) Wait for brand-new entries (">" = never delivered to anyone in this group).
      const res = await blocking.xreadgroup(
        'GROUP', GROUP, WORKER_ID, 'COUNT', BATCH, 'BLOCK', BLOCK_MS, 'STREAMS', STREAM, '>',
      );
      if (res) {
        for (const [, entries] of res) await processEntries(entries);
      }
      lastErrorMessage = null;
    } catch (err) {
      if (stopping) break;
      if (err instanceof PostgresUnavailable) {
        // Nothing was acked: the entries stay pending and are reclaimed once Postgres is back.
        console.error(`${TAG} postgres unavailable (${err.message}) - entries stay pending, waiting...`);
        await waitForPostgres({ retryMs: RETRY_SLEEP_MS });
        if (!stopping) console.log(`${TAG} postgres is back - resuming`);
      } else if (String(err.message).includes('NOGROUP')) {
        // `npm run reset` deleted the stream under us: recreate the group and carry on.
        await ensureGroup().catch(() => {});
        await sleep(RETRY_SLEEP_MS);
      } else {
        // Log each distinct problem once, not once per second.
        const text = describeError(err);
        if (text !== lastErrorMessage) {
          lastErrorMessage = text;
          const kind = isConnectionError(err) ? 'redis unavailable' : 'error';
          console.error(`${TAG} ${kind}: ${text} - retrying every ${RETRY_SLEEP_MS} ms`);
        }
        await sleep(RETRY_SLEEP_MS);
      }
    }
  }
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${TAG} ${signal} received, finishing current batch...`);
  const force = setTimeout(() => process.exit(0), BLOCK_MS + 3000).unref();
  // The blocking XREADGROUP returns within BLOCK_MS; disconnecting it makes that immediate.
  blocking.disconnect();
  await redis.quit().catch(() => redis.disconnect());
  await pool.end().catch(() => {});
  clearTimeout(force);
  process.exit(0);
}

async function main() {
  console.log(`${TAG} starting (stream=${STREAM}, group=${GROUP})`);
  await waitUntilReady(redis);
  await waitUntilReady(blocking);
  await ensureGroup();
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  console.log(`${TAG} consuming`);
  await loop();
}

process.on('unhandledRejection', (reason) => {
  console.error(`${TAG} unhandled rejection:`, reason && reason.stack ? reason.stack : reason);
});

main().catch((err) => {
  console.error(`${TAG} fatal: ${err.stack || err.message}`);
  process.exit(1);
});
