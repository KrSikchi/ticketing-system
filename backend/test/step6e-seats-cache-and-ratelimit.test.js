'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { redis } = require('../src/redis');
const { cleanRedis, startTestServer } = require('./helpers');
const inventory = require('../src/services/inventory');
const rateLimit = require('../src/middleware/rateLimit');

describe('Step 6e: GET /seats in-process cache, single-flight deduplication, and IP rate limit', () => {
  let srv;

  before(async () => {
    srv = await startTestServer();
  });

  beforeEach(async () => {
    await cleanRedis();
    if (typeof inventory.invalidateSeatMapCache === 'function') {
      inventory.invalidateSeatMapCache();
    }
  });

  after(async () => {
    await srv.close();
  });

  it('deduplicates concurrent getSeatMap() calls into one Redis pipeline and caches for ~250ms', async () => {
    assert.equal(typeof config.SEATMAP_CACHE_MS, 'number', 'config.SEATMAP_CACHE_MS must be defined');
    assert.equal(typeof inventory.invalidateSeatMapCache, 'function', 'invalidateSeatMapCache must be exported');

    let pipelineCalls = 0;
    const origPipeline = redis.pipeline.bind(redis);
    redis.pipeline = function (...args) {
      pipelineCalls += 1;
      return origPipeline(...args);
    };

    try {
      // Launch 20 concurrent getSeatMap() calls -> should only execute 1 Redis pipeline
      const results = await Promise.all(
        Array.from({ length: 20 }, () => inventory.getSeatMap())
      );
      assert.equal(pipelineCalls, 1, 'concurrent getSeatMap() calls must share a single in-flight promise');
      for (const r of results) {
        assert.equal(r.length, config.TOTAL_UNITS);
      }

      // Calling again immediately within SEATMAP_CACHE_MS should hit the cache (still 1 pipeline call)
      const cached = await inventory.getSeatMap();
      assert.equal(pipelineCalls, 1, 'subsequent getSeatMap() within cache TTL must return cached snapshot');
      assert.equal(cached.length, config.TOTAL_UNITS);
    } finally {
      redis.pipeline = origPipeline;
    }
  });

  it('enforces IP rate limit on GET /seats', async () => {
    assert.equal(typeof rateLimit.ipRateLimit, 'function', 'rateLimit.ipRateLimit must be exported');

    const prevCap = process.env.IP_BUCKET_CAPACITY;
    const prevRefill = process.env.IP_BUCKET_REFILL_PER_SEC;
    process.env.IP_BUCKET_CAPACITY = '3';
    process.env.IP_BUCKET_REFILL_PER_SEC = '1';

    try {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${srv.baseUrl}/seats`);
        assert.equal(res.status, 200);
      }
      const blocked = await fetch(`${srv.baseUrl}/seats`);
      assert.equal(blocked.status, 429);
      const body = await blocked.json();
      assert.equal(body.error, 'RATE_LIMITED');
    } finally {
      if (prevCap === undefined) delete process.env.IP_BUCKET_CAPACITY;
      else process.env.IP_BUCKET_CAPACITY = prevCap;
      if (prevRefill === undefined) delete process.env.IP_BUCKET_REFILL_PER_SEC;
      else process.env.IP_BUCKET_REFILL_PER_SEC = prevRefill;
    }
  });
});
