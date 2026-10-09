// Live seat-state fan-out over Socket.IO. A dedicated Redis connection subscribes to the
// "seat-events" channel (published by inventory.js from ANY API instance) and every message is
// re-emitted to this instance's clients as event "seat". New clients get the full map once.
// Everything here is best-effort: a failure must never affect booking.
'use strict';

const { Server } = require('socket.io');
const config = require('./config');
const { createRedis } = require('./redis');
const { getSeatMap } = require('./services/inventory');

function attachSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' }, // hackathon: any origin may watch the seat map
    serveClient: false,
  });

  // A subscribed connection cannot run normal commands -> it must be its own connection.
  const subscriber = createRedis('subscriber');

  // (Re)subscribe on every 'ready' so a Redis restart never leaves us silently unsubscribed.
  subscriber.on('ready', () => {
    subscriber.subscribe(config.channel).catch((err) => {
      console.warn(`[socket] subscribe failed: ${err.message}`);
    });
  });

  subscriber.on('message', (channel, message) => {
    if (channel !== config.channel) return;
    try {
      io.emit('seat', JSON.parse(message)); // {unit, state: 'held' | 'free' | 'sold'}
    } catch (_) {
      /* malformed message: ignore */
    }
  });

  io.on('connection', async (socket) => {
    try {
      socket.emit('seatmap', { event: config.EVENT_ID, total: config.TOTAL_UNITS, seats: await getSeatMap() });
    } catch (err) {
      socket.emit('seatmap_error', { error: 'SERVICE_UNAVAILABLE' });
    }
  });

  /** Close Socket.IO and the subscriber connection (used by graceful shutdown). */
  async function close() {
    await new Promise((resolve) => io.close(() => resolve()));
    await subscriber.quit().catch(() => subscriber.disconnect());
  }

  return { io, close };
}

module.exports = { attachSocket };
