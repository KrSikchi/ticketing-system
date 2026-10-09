// Token-bucket rate limiter evaluated inside Redis with Redis's own clock (bucket.lua).
// Checks BOTH a per-IP bucket (higher capacity/refill so a single-IP load test is not throttled,
// while stopping Sybil floods across forged user IDs) and a per-user bucket.
// If Redis is unreachable the error propagates -> 503 (fail closed).
'use strict';

const config = require('../config');
const { redis } = require('../redis');

async function ipRateLimit(req, res, next) {
  if (!config.RATE_LIMIT_ENABLED) return next();
  try {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const ipCap = Number(process.env.IP_BUCKET_CAPACITY || config.IP_BUCKET_CAPACITY);
    const ipRefill = Number(process.env.IP_BUCKET_REFILL_PER_SEC || config.IP_BUCKET_REFILL_PER_SEC);
    const ipAllowed = await redis.bucket(config.ipRlKey(ip), ipCap, ipRefill);
    if (Number(ipAllowed) !== 1) {
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

async function rateLimit(req, res, next) {
  if (!config.RATE_LIMIT_ENABLED) return next();
  try {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const ipCap = Number(process.env.IP_BUCKET_CAPACITY || config.IP_BUCKET_CAPACITY);
    const ipRefill = Number(process.env.IP_BUCKET_REFILL_PER_SEC || config.IP_BUCKET_REFILL_PER_SEC);
    const ipAllowed = await redis.bucket(config.ipRlKey(ip), ipCap, ipRefill);
    if (Number(ipAllowed) !== 1) {
      return res.status(429).json({ error: 'RATE_LIMITED' });
    }

    const userCap = Number(process.env.BUCKET_CAPACITY || config.BUCKET_CAPACITY);
    const userRefill = Number(process.env.BUCKET_REFILL_PER_SEC || config.BUCKET_REFILL_PER_SEC);
    const allowed = await redis.bucket(config.rlKey(req.userId), userCap, userRefill);
    if (Number(allowed) === 1) return next();
    return res.status(429).json({ error: 'RATE_LIMITED' });
  } catch (err) {
    return next(err);
  }
}

rateLimit.ipRateLimit = ipRateLimit;
module.exports = rateLimit;
