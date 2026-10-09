'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { cleanRedis } = require('./helpers');
const app = require('../src/app');
const { attachSocket } = require('../src/socket');
const { holdSeat, releaseSeat, confirmSeat, getSeatMap } = require('../src/services/inventory');
const crypto = require('crypto');

describe('Step 6c: Monotonic sequence numbers in seat events and seatmap snapshot', () => {
  let httpServer;
  let socketHandle;
  let port;

  before(async () => {
    httpServer = http.createServer(app);
    socketHandle = attachSocket(httpServer);
    await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
    port = httpServer.address().port;
    await new Promise((r) => setTimeout(r, 80));
  });

  beforeEach(async () => {
    await cleanRedis();
  });

  after(async () => {
    if (socketHandle) await socketHandle.close();
    if (httpServer) await new Promise((r) => httpServer.close(r));
  });

  it('includes monotonically increasing seq in every seat event and in the seatmap snapshot', async () => {
    const seatEvents = [];
    let initialSeatmap = null;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for seatmap')), 2000);
      ws.onmessage = (e) => {
        const data = String(e.data);
        if (data.startsWith('0')) ws.send('40');
        else if (data.startsWith('42["seatmap"')) {
          clearTimeout(t);
          initialSeatmap = JSON.parse(data.slice(2))[1];
          resolve();
        } else if (data.startsWith('42["seat"')) {
          seatEvents.push(JSON.parse(data.slice(2))[1]);
        }
      };
    });

    try {
      assert.equal(typeof initialSeatmap.seq, 'number', 'initial seatmap must include numeric seq');
      assert.equal(initialSeatmap.seq, 0);

      await holdSeat(1, 'alice');
      await releaseSeat(1, 'alice');
      await holdSeat(2, 'bob');
      await confirmSeat(2, 'bob', crypto.randomUUID());

      await new Promise((r) => setTimeout(r, 100));

      assert.equal(seatEvents.length, 4);
      for (let i = 0; i < seatEvents.length; i++) {
        assert.equal(typeof seatEvents[i].seq, 'number', `event ${i} must carry numeric seq`);
        if (i > 0) {
          assert.ok(seatEvents[i].seq > seatEvents[i - 1].seq, `seq must strictly increase (${seatEvents[i - 1].seq} -> ${seatEvents[i].seq})`);
        }
      }

      const mapAfter = await getSeatMap();
      assert.equal(mapAfter.seq, seatEvents[seatEvents.length - 1].seq);
    } finally {
      ws.close();
    }
  });
});
