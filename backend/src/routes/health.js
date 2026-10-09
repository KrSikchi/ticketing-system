// GET /health - liveness/readiness probe. Pings Redis and runs SELECT 1 on Postgres.
// This is the ONLY route allowed to touch Postgres (and only for the probe). Booking keeps working
// while Postgres is down; the 503 here just makes a degraded dependency visible to operators.
'use strict';

const express = require('express');
const config = require('../config');
const { redis } = require('../redis');
const { pool } = require('../pg');

const router = express.Router();

/** Resolve to 'ok' or 'down' without ever throwing, and never wait longer than `ms`. */
async function probe(promiseFactory, ms = 1500) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); });
  try {
    await Promise.race([promiseFactory(), timeout]);
    return 'ok';
  } catch (_) {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

router.get('/health', async (req, res) => {
  const [redisPing, readyFlag, pgState] = await Promise.all([
    probe(() => redis.ping()),
    probe(async () => {
      const exists = await redis.exists(config.readyKey());
      if (exists !== 1) throw new Error('not_ready');
    }),
    probe(() => pool.query('SELECT 1')),
  ]);
  const ready = redisPing === 'ok' && readyFlag === 'ok';
  const redisState = redisPing !== 'ok' ? 'down' : (ready ? 'ok' : 'not_ready');
  const healthy = redisState === 'ok' && pgState === 'ok';
  res.status(healthy ? 200 : 503).json({ redis: redisState, postgres: pgState, ready, port: config.PORT });
});

module.exports = router;
