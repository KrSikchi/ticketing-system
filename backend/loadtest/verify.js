// Post-test consistency check. Waits (max 30 s) until the bookings stream is drained and Postgres
// has as many rows as Redis has sold seats, then prints Redis sold count, Postgres count, duplicate
// seats, dead letters and Redis<->Postgres mismatches. PASS requires: redisSold == pgCount,
// duplicates == 0, dead_letters == 0, pgCount <= TOTAL_UNITS. Exit code 0 on PASS, 1 on FAIL.
'use strict';

const config = require('../src/config');
const { redis, waitUntilReady } = require('../src/redis');
const { pool, waitForPostgres } = require('../src/pg');

const TIMEOUT_MS = 30000;
const POLL_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Entries still in the stream (unprocessed) + entries delivered but not yet acked. */
async function streamBacklog() {
  const length = await redis.xlen(config.streamKey);
  let pending = 0;
  try {
    const summary = await redis.xpending(config.streamKey, config.group);
    pending = summary ? Number(summary[0]) : 0;
  } catch (err) {
    if (!String(err.message).includes('NOGROUP')) throw err;
    // Group missing = no worker ever ran; count every entry as unprocessed.
    pending = 0;
  }
  return { length, pending };
}

async function counts() {
  const [sold, { rows }] = await Promise.all([
    redis.hgetall(config.soldKey()),
    pool.query('SELECT COUNT(*)::int AS n FROM bookings WHERE event_id = $1', [config.EVENT_ID]),
  ]);
  return { sold, redisSold: Object.keys(sold).length, pgCount: rows[0].n };
}

async function main() {
  await waitUntilReady(redis);
  await waitForPostgres({ maxWaitMs: TIMEOUT_MS });

  // ---- 1. wait for the async pipeline to settle ----
  const started = Date.now();
  let drained = false;
  let snapshot;
  process.stdout.write('Waiting for the bookings stream to drain and Postgres to catch up');
  for (;;) {
    const backlog = await streamBacklog();
    snapshot = await counts();
    drained = backlog.length === 0 && backlog.pending === 0 && snapshot.redisSold === snapshot.pgCount;
    if (drained || Date.now() - started > TIMEOUT_MS) break;
    process.stdout.write('.');
    await sleep(POLL_MS);
  }
  console.log(drained ? ` drained in ${((Date.now() - started) / 1000).toFixed(1)} s` : ` TIMEOUT after ${TIMEOUT_MS / 1000} s`);

  // ---- 2. gather the evidence ----
  const backlog = await streamBacklog();
  const { sold, redisSold, pgCount } = snapshot;
  const dup = await pool.query(
    'SELECT unit_id, COUNT(*)::int AS n FROM bookings WHERE event_id = $1 GROUP BY unit_id HAVING COUNT(*) > 1',
    [config.EVENT_ID],
  );
  const dead = await pool.query('SELECT COUNT(*)::int AS n FROM dead_letters');
  const deadLetters = dead.rows[0].n;

  // Row-level cross-check: every Redis sold entry (unit -> bookingId) must exist in Postgres and vice versa.
  const pgRows = await pool.query('SELECT unit_id, booking_id FROM bookings WHERE event_id = $1', [config.EVENT_ID]);
  const pgMap = new Map(pgRows.rows.map((r) => [String(r.unit_id), String(r.booking_id)]));
  const mismatches = [];
  for (const [unit, bookingId] of Object.entries(sold)) {
    if (pgMap.get(unit) !== bookingId) mismatches.push(`unit ${unit}: redis=${bookingId} pg=${pgMap.get(unit) || 'missing'}`);
  }
  for (const [unit, bookingId] of pgMap) {
    if (!(unit in sold)) mismatches.push(`unit ${unit}: redis=missing pg=${bookingId}`);
  }

  // ---- 3. report ----
  console.log('\n' + '='.repeat(72));
  console.log(' VERIFY');
  console.log('='.repeat(72));
  console.log(`  Redis sold count (HLEN ${config.soldKey()}) : ${redisSold}`);
  console.log(`  Postgres bookings count                : ${pgCount}`);
  console.log(`  Seat capacity (TOTAL_UNITS)            : ${config.TOTAL_UNITS}`);
  console.log(`  Duplicate seats in Postgres            : ${dup.rows.length}${dup.rows.length ? '  <-- ' + dup.rows.map((r) => `unit ${r.unit_id} x${r.n}`).join(', ') : ''}`);
  console.log(`  dead_letters rows                      : ${deadLetters}`);
  console.log(`  Redis<->Postgres row mismatches        : ${mismatches.length}`);
  console.log(`  Stream backlog (unprocessed / pending) : ${backlog.length} / ${backlog.pending}`);
  for (const m of mismatches.slice(0, 10)) console.log(`    - ${m}`);

  const checks = [
    [redisSold === pgCount, `Redis sold (${redisSold}) == Postgres (${pgCount})`],
    [dup.rows.length === 0, 'no duplicate seats'],
    [deadLetters === 0, 'no dead letters'],
    [pgCount <= config.TOTAL_UNITS, `Postgres count (${pgCount}) <= capacity (${config.TOTAL_UNITS})`],
    [mismatches.length === 0, 'Redis and Postgres agree on every (unit, bookingId)'],
  ];
  console.log('');
  for (const [ok, text] of checks) console.log(`  [${ok ? 'x' : ' '}] ${text}`);
  const pass = checks.every(([ok]) => ok);

  console.log('\n' + '='.repeat(72));
  console.log(pass ? ' PASS - zero double bookings, Redis and Postgres consistent' : ' FAIL - see the unchecked items above');
  console.log('='.repeat(72));
  return pass;
}

main()
  .then(async (pass) => {
    await Promise.all([redis.quit().catch(() => {}), pool.end().catch(() => {})]);
    process.exit(pass ? 0 : 1);
  })
  .catch((err) => {
    console.error('verify crashed:', err.message);
    process.exit(1);
  });
