'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { config, redis, cleanRedis } = require('./helpers');
const app = require('../src/app');
const { attachSocket, getRedisDbIndex } = require('../src/socket');
const { holdSeat } = require('../src/services/inventory');
const { createRedis, waitUntilReady } = require('../src/redis');

describe('Step 6b: Emit free seat event on Redis hold key TTL expiry', () => {
  let httpServer;
  let socketHandle;
  let port;

  before(async () => {
    await waitUntilReady(redis);
    await redis.config('SET', 'notify-keyspace-events', 'Ex');
    httpServer = http.createServer(app);
    socketHandle = attachSocket(httpServer);
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
    port = httpServer.address().port;
    // Wait briefly for subscriber connection to be ready and subscribed
    await new Promise((r) => setTimeout(r, 80));
  });

  beforeEach(async () => {
    delete process.env.HOLD_TTL_MS;
    await cleanRedis();
  });

  after(async () => {
    delete process.env.HOLD_TTL_MS;
    if (socketHandle) await socketHandle.close();
    if (httpServer) await new Promise((r) => httpServer.close(r));
  });

  it('sets --notify-keyspace-events Ex in docker-compose.yml and parses Redis DB index from URL', () => {
    const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
    assert.match(compose, /--notify-keyspace-events\s+Ex/);
    assert.equal(typeof getRedisDbIndex, 'function');
    assert.equal(getRedisDbIndex('redis://127.0.0.1:6379'), 0);
    assert.equal(getRedisDbIndex('redis://127.0.0.1:6379/3'), 3);
  });

  it('emits seat {unit, state:"free"} to Socket.IO clients when a hold expires, without republishing to shared channel', async () => {
    process.env.HOLD_TTL_MS = '80';

    // Track messages on the shared Pub/Sub channel to ensure expiry is NOT republished there
    const channelSpy = createRedis('channel-spy');
    await waitUntilReady(channelSpy);
    const channelMessages = [];
    channelSpy.on('message', (ch, msg) => {
      if (ch === config.channel) channelMessages.push(JSON.parse(msg));
    });
    await channelSpy.subscribe(config.channel);

    // Connect a Socket.IO WebSocket client
    const seatEvents = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for seatmap')), 2000);
      ws.onmessage = (e) => {
        const data = String(e.data);
        if (data.startsWith('0')) ws.send('40');
        else if (data.startsWith('42["seatmap"')) {
          clearTimeout(t);
          resolve();
        } else if (data.startsWith('42["seat"')) {
          const parsed = JSON.parse(data.slice(2));
          seatEvents.push(parsed[1]);
        }
      };
    });

    try {
      // Place a hold with 80ms TTL -> emits 'held' on shared channel, then expires after ~80ms -> emits 'free' directly
      const status = await holdSeat(19, 'alice');
      assert.equal(status, 'OK');

      await new Promise((r) => setTimeout(r, 200));

      const heldEvt = seatEvents.find((e) => e.unit === 19 && e.state === 'held');
      const freeEvt = seatEvents.find((e) => e.unit === 19 && e.state === 'free');
      assert.ok(heldEvt, 'client should receive held event');
      assert.ok(freeEvt, 'client should receive free event upon TTL expiry');

      // Shared channel must have 'held' but NOT 'free' (expiry must not be republished on shared channel)
      const sharedFree = channelMessages.find((e) => e.unit === 19 && e.state === 'free');
      assert.equal(sharedFree, undefined, 'expiry event must not be republished to shared channel');
    } finally {
      ws.close();
      await channelSpy.quit().catch(() => channelSpy.disconnect());
    }
  });
});
