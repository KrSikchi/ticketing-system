// Headless flash-sale load test: USERS (default 5000) virtual users start AT THE SAME TIME and
// fight over SEATS (default 200) seats through POST /book, round-robin across the 3 API ports via
// undici connection pools. Prints outcome counts, latency percentiles and throughput.
// Exit code 1 if more seats were BOOKED than exist (= a double booking happened).
//
// Usage:  node loadtest/race.js            (env: USERS, SEATS, PORTS, HOST)
//         USERS=10000 SEATS=200 node loadtest/race.js
'use strict';

const { Pool } = require('undici');
const { performance } = require('perf_hooks');

const USERS = Number(process.env.USERS || 5000);
const SEATS = Number(process.env.SEATS || 200);
const HOST = process.env.HOST || '127.0.0.1';
const PORTS = (process.env.PORTS || '3001,3002,3003').split(',').map((p) => p.trim()).filter(Boolean);
const CONNECTIONS_PER_PORT = Number(process.env.CONNECTIONS || 100);

const HELD_MAX_RETRIES = 5;      // retry the same seat after 20-80 ms while someone else holds it
const RATE_LIMIT_MAX_RETRIES = 3; // 429 -> wait 100 ms, try again

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// ---- HTTP plumbing ------------------------------------------------------------------------------
const pools = PORTS.map((port) => new Pool(`http://${HOST}:${port}`, {
  connections: CONNECTIONS_PER_PORT,
  pipelining: 1,
  keepAliveTimeout: 60000,
  headersTimeout: 60000,
  bodyTimeout: 60000,
}));
let rr = 0;
const nextPool = () => pools[rr++ % pools.length];

// ---- Stats --------------------------------------------------------------------------------------
const responses = new Map(); // label -> count, for EVERY request (incl. retries)
const finals = new Map();    // label -> count, ONE per virtual user
const latencies = [];        // ms, every request
const errorSamples = new Map();
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

/** Human label for a response: "200 BOOKED", "409 SOLD", "503 UNAVAILABLE", "NETWORK_ERROR"... */
function labelOf(r) {
  if (r.status === 0) return 'NETWORK_ERROR';
  const body = r.json || {};
  if (r.status === 200) return '200 BOOKED';
  if (r.status === 409) return `409 ${body.reason || 'CONFLICT'}`;
  if (r.status === 402) return '402 PAYMENT_FAILED';
  if (r.status === 410) return '410 EXPIRED';
  if (r.status === 429) return '429 RATE_LIMITED';
  if (r.status === 503) return '503 UNAVAILABLE';
  return `${r.status} ${body.reason || body.error || 'OTHER'}`;
}

/** POST /book for one user & seat. Never throws; network errors come back as status 0. */
async function book(userId, unit) {
  const started = performance.now();
  try {
    const res = await nextPool().request({
      method: 'POST',
      path: '/book',
      headers: { 'content-type': 'application/json', 'x-user-id': userId },
      body: JSON.stringify({ unit }),
    });
    const text = await res.body.text(); // always drain the body so the connection is reusable
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* non-JSON body */ }
    const r = { status: res.statusCode, json };
    latencies.push(performance.now() - started);
    bump(responses, labelOf(r));
    return r;
  } catch (err) {
    latencies.push(performance.now() - started);
    bump(responses, 'NETWORK_ERROR');
    const key = err.code || err.message;
    errorSamples.set(key, (errorSamples.get(key) || 0) + 1);
    return { status: 0, json: null, error: err };
  }
}

/**
 * Try to buy ONE seat, following the retry rules:
 *  - 409 HELD -> back off 20-80 ms and retry the same seat, up to HELD_MAX_RETRIES times
 *  - 429      -> wait 100 ms and retry, up to RATE_LIMIT_MAX_RETRIES times
 * Returns the final label for this seat attempt.
 */
async function attemptSeat(userId, unit) {
  let heldRetries = 0;
  let rateLimitRetries = 0;
  for (;;) {
    const r = await book(userId, unit);
    const label = labelOf(r);
    if (label === '409 HELD' && heldRetries < HELD_MAX_RETRIES) {
      heldRetries += 1;
      await sleep(randomInt(20, 80));
      continue;
    }
    if (label === '429 RATE_LIMITED' && rateLimitRetries < RATE_LIMIT_MAX_RETRIES) {
      rateLimitRetries += 1;
      await sleep(100);
      continue;
    }
    return label;
  }
}

/** One virtual user: a random seat; if it is SOLD, one different random seat; then stop. */
async function runUser(n) {
  const userId = `user-${n}`;
  const first = randomInt(1, SEATS);
  let outcome = await attemptSeat(userId, first);
  if (outcome === '409 SOLD' && SEATS > 1) {
    let second = randomInt(1, SEATS - 1);
    if (second >= first) second += 1; // guaranteed different from the first pick
    outcome = await attemptSeat(userId, second);
  }
  bump(finals, outcome);
}

// ---- Reporting ----------------------------------------------------------------------------------
function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function printTable(title, map) {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n${title}`);
  console.log(`  ${'outcome'.padEnd(28)}${'count'.padStart(8)}`);
  console.log(`  ${'-'.repeat(36)}`);
  for (const [label, count] of rows) console.log(`  ${label.padEnd(28)}${String(count).padStart(8)}`);
  if (!rows.length) console.log('  (none)');
}

/**
 * Pre-flight: every instance must answer and have Redis. Postgres being down is only a warning -
 * booking does not need it (that is the point of the design), so chaos runs can start without it.
 */
async function checkHealth() {
  const results = await Promise.all(pools.map(async (pool, i) => {
    try {
      const res = await pool.request({ method: 'GET', path: '/health', headersTimeout: 5000 });
      const body = await res.body.json();
      return { port: PORTS[i], ok: body.redis === 'ok', degraded: body.postgres !== 'ok', body };
    } catch (err) {
      return { port: PORTS[i], ok: false, body: { error: err.code || err.message } };
    }
  }));
  for (const r of results) {
    const state = r.ok ? (r.degraded ? 'OK (postgres down - booking still works)' : 'OK') : 'NOT HEALTHY';
    console.log(`  port ${r.port}: ${state} ${JSON.stringify(r.body)}`);
  }
  return results.every((r) => r.ok);
}

async function main() {
  console.log('='.repeat(72));
  console.log(' FLASH-RESERVATION LOAD TEST');
  console.log('='.repeat(72));
  console.log(`  users=${USERS}  seats=${SEATS}  targets=${PORTS.map((p) => `${HOST}:${p}`).join(', ')}  connections/port=${CONNECTIONS_PER_PORT}`);
  console.log('\nHealth check:');
  const healthy = await checkHealth();
  if (!healthy) {
    console.error('\nSome API instances are not healthy. Start them with `npm run start:all` and try again.');
    await Promise.all(pools.map((p) => p.close()));
    process.exit(2);
  }

  console.log(`\nLaunching ${USERS} concurrent users...`);
  const started = performance.now();
  await Promise.all(Array.from({ length: USERS }, (_, i) => runUser(i + 1)));
  const durationMs = performance.now() - started;

  // ---- Summary ----
  const total = latencies.length;
  const sorted = [...latencies].sort((a, b) => a - b);
  const booked = finals.get('200 BOOKED') || 0;

  printTable('Final outcome per user (one row per virtual user):', finals);
  printTable('All responses (including retries):', responses);
  if (errorSamples.size) {
    console.log('\nNetwork error breakdown:');
    for (const [k, v] of errorSamples) console.log(`  ${k.padEnd(28)}${String(v).padStart(8)}`);
  }

  console.log('\nLatency (ms, all requests):');
  console.log(`  p50=${percentile(sorted, 50).toFixed(1)}  p95=${percentile(sorted, 95).toFixed(1)}  p99=${percentile(sorted, 99).toFixed(1)}  max=${(sorted[sorted.length - 1] || 0).toFixed(1)}`);
  console.log('\nThroughput:');
  console.log(`  ${total} requests in ${(durationMs / 1000).toFixed(2)} s  ->  ${(total / (durationMs / 1000)).toFixed(1)} req/s`);

  console.log('\n' + '='.repeat(72));
  if (booked > SEATS) {
    console.log(` RESULT: FAIL - ${booked} BOOKED for ${SEATS} seats (DOUBLE BOOKING!)`);
    console.log('='.repeat(72));
    await Promise.all(pools.map((p) => p.close()));
    process.exit(1);
  }
  console.log(` RESULT: OK - ${booked} BOOKED <= ${SEATS} seats${booked < SEATS ? ` (${SEATS - booked} seats unsold: expected only with payment failures / HELD give-ups)` : ''}`);
  console.log(' Now run `npm run verify` to cross-check Redis vs Postgres.');
  console.log('='.repeat(72));
  await Promise.all(pools.map((p) => p.close()));
}

main().catch((err) => {
  console.error('load test crashed:', err);
  process.exit(1);
});
