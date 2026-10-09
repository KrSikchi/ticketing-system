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

  console.log(`[rehydrate] event ${config.EVENT_ID}: ${rows.length} sold seats in Postgres, ${restored} restored into Redis`);
  return restored;
}

module.exports = rehydrate;
