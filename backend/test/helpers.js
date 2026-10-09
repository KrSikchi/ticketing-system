'use strict';

const http = require('http');
const crypto = require('crypto');
const { after } = require('node:test');

// Set a unique EVENT_ID per test file process before loading config/redis
if (!process.env.EVENT_ID) {
  process.env.EVENT_ID = `t_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
}
if (!process.env.PAYMENT_DELAY_MS) {
  process.env.PAYMENT_DELAY_MS = '5';
}

const config = require('../src/config');
const { redis, waitUntilReady } = require('../src/redis');
const { pool } = require('../src/pg');
const app = require('../src/app');
const inventory = require('../src/services/inventory');

async function scanDelete(pattern) {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
}

async function cleanRedis({ setReady = true } = {}) {
  await waitUntilReady(redis);
  await scanDelete(`evt:{${config.EVENT_ID}}:*`);
  await scanDelete(config.payKey('*'));
  await scanDelete(config.rlKey('*'));
  if (typeof config.ipRlKey === 'function') {
    await scanDelete(config.ipRlKey('*'));
  }
  await redis.del(config.streamKey);
  if (config.legacyStreamKey) await redis.del(config.legacyStreamKey);
  if (setReady && typeof config.readyKey === 'function') {
    await redis.set(config.readyKey(), '1');
  }
  if (typeof inventory.invalidateSeatMapCache === 'function') {
    inventory.invalidateSeatMapCache();
  }
}

async function startTestServer() {
  await waitUntilReady(redis);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  async function request(method, path, { headers = {}, body } = {}) {
    const reqHeaders = { ...headers };
    let payload;
    if (body !== undefined) {
      reqHeaders['content-type'] = reqHeaders['content-type'] || 'application/json';
      payload = typeof body === 'string' ? body : JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: reqHeaders,
      body: payload,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* ignore */ }
    return { status: res.status, headers: res.headers, json, text };
  }

  async function close() {
    await new Promise((resolve) => server.close(resolve));
  }

  return { server, port, baseUrl, request, close };
}

let tornDown = false;
async function teardownConnections() {
  if (tornDown) return;
  tornDown = true;
  await cleanRedis({ setReady: false }).catch(() => {});
  await redis.quit().catch(() => redis.disconnect());
  await pool.end().catch(() => {});
}

after(async () => {
  await teardownConnections();
});

module.exports = {
  config,
  redis,
  pool,
  cleanRedis,
  startTestServer,
  teardownConnections,
};
