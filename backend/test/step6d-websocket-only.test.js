'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { cleanRedis } = require('./helpers');
const app = require('../src/app');
const { attachSocket } = require('../src/socket');

describe('Step 6d: Disable Socket.IO HTTP polling transport (transports: ["websocket"])', () => {
  let httpServer;
  let socketHandle;
  let port;

  before(async () => {
    await cleanRedis();
    httpServer = http.createServer(app);
    socketHandle = attachSocket(httpServer);
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
    port = httpServer.address().port;
  });

  after(async () => {
    if (socketHandle) await socketHandle.close();
    if (httpServer) await new Promise((r) => httpServer.close(r));
  });

  it('rejects HTTP long-polling transport while allowing direct WebSocket connections', async () => {
    // 1. HTTP polling handshake must be rejected (400 Transport unknown)
    const pollRes = await fetch(`http://127.0.0.1:${port}/socket.io/?EIO=4&transport=polling`);
    assert.notEqual(pollRes.status, 200, 'HTTP polling transport must be disabled');

    // 2. Direct WebSocket transport must succeed
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    const openPacket = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 2000);
      ws.onmessage = (e) => {
        clearTimeout(t);
        resolve(String(e.data));
      };
      ws.onerror = reject;
    });
    ws.close();
    assert.ok(openPacket.startsWith('0{'), 'WebSocket transport should receive Engine.IO open packet');
  });
});
