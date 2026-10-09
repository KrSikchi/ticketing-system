// Per-user token-bucket rate limiter. The bucket lives in Redis and is evaluated by bucket.lua
// with Redis's own clock, so all three API instances share one limit per user and no instance
// needs any local state. If Redis is unreachable the error propagates -> 503 (fail closed).
'use strict';

const config = require('../config');
const { redis } = require('../redis');

async function rateLimit(req, res, next) {
  if (!config.RATE_LIMIT_ENABLED) return next();
  try {
    const allowed = await redis.bucket(
      config.rlKey(req.userId), config.BUCKET_CAPACITY, config.BUCKET_REFILL_PER_SEC,
    );
    if (Number(allowed) === 1) return next();
    return res.status(429).json({ error: 'RATE_LIMITED' });
  } catch (err) {
    return next(err);
  }
}

module.exports = rateLimit;
