// Postgres connection pool (max 10) for the few places allowed to touch the database:
// rehydrate.js, /health, the persist workers, scripts and loadtest/verify.js.
// API booking routes must NEVER import this module - Redis is the only thing on the hot path.
'use strict';

const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 3000, // do not hang forever when Postgres is down
  idleTimeoutMillis: 30000,
  query_timeout: 10000,
});

// An idle client can error out when Postgres is stopped (chaos scenario 2). Without a listener
// pg would re-throw it as an uncaught exception and kill the process - log it instead.
let poolErrorLogged = false;
pool.on('error', (err) => {
  if (poolErrorLogged) return;
  poolErrorLogged = true;
  console.error(`[pg] idle client error: ${err.message}`);
});
pool.on('connect', () => { poolErrorLogged = false; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Human-readable text for any error. Node >= 18 connects to "localhost" over IPv6 and IPv4 and
 * reports a refused connection as an AggregateError whose own .message is EMPTY - unwrap it.
 */
function describeError(err) {
  if (err && Array.isArray(err.errors) && err.errors.length) return describeError(err.errors[0]);
  if (!err) return 'unknown error';
  return err.message || err.code || String(err);
}

/**
 * Block until `SELECT 1` succeeds. Used at boot (and by scripts) because `docker compose up -d`
 * returns before Postgres has finished its first init, and by the persist workers while Postgres
 * is down. Logs once, then retries quietly.
 */
async function waitForPostgres({ retryMs = 1000, maxWaitMs = Infinity } = {}) {
  const started = Date.now();
  let warned = false;
  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (Date.now() - started >= maxWaitMs) throw err;
      if (!warned) {
        warned = true;
        console.warn(`[pg] not reachable (${describeError(err)}); retrying every ${retryMs} ms...`);
      }
      await sleep(retryMs);
    }
  }
}

module.exports = { pool, waitForPostgres, describeError };
