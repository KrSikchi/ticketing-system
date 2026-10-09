// Live seat-state fan-out over Socket.IO. A dedicated Redis connection subscribes to the
// "seat-events" channel (published by inventory.js from ANY API instance) and every message is
// re-emitted to this instance's clients as event "seat". New clients get the full map once.
// Everything here is best-effort: a failure must never affect booking.
'use strict';

const { Server } = require('socket.io');
const config = require('./config');
const { redis, createRedis } = require('./redis');
const { getSeatMap } = require('./services/inventory');

/** Extract the Redis database index from a redis:// URL (defaults to 0). */
function getRedisDbIndex(redisUrl) {
  try {
    const u = new URL(redisUrl);
    const pathPart = (u.pathname || '').replace(/^\/+/, '');
    if (pathPart && /^\d+$/.test(pathPart)) return Number(pathPart);
  } catch (_) {
    /* ignore */
  }
  return 0;
}

function attachSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' }, // hackathon: any origin may watch the seat map
    serveClient: false,
  });

  // A subscribed connection cannot run normal commands -> it must be its own connection.
  const subscriber = createRedis('subscriber');
  const expiredChannel = `__keyevent@${getRedisDbIndex(config.REDIS_URL)}__:expired`;
  const holdPrefix = config.holdKey('');

  // (Re)subscribe on every 'ready' so a Redis restart never leaves us silently unsubscribed.
  subscriber.on('ready', () => {
    redis.config('SET', 'notify-keyspace-events', 'Ex').catch(() => {});
    subscriber.subscribe(config.channel, expiredChannel).catch((err) => {
      console.warn(`[socket] subscribe failed: ${err.message}`);
    });
  });

  subscriber.on('message', (channel, message) => {
    if (channel === config.channel) {
      try {
        io.emit('seat', JSON.parse(message)); // {unit, state: 'held' | 'free' | 'sold'}
      } catch (_) {
        /* malformed message: ignore */
      }
      return;
    }
    if (channel === expiredChannel && typeof message === 'string' && message.startsWith(holdPrefix)) {
      const unit = Number(message.slice(holdPrefix.length));
      if (Number.isInteger(unit) && unit >= 1 && unit <= config.TOTAL_UNITS) {
        // Emit directly on this instance; do NOT republish through config.channel.
        redis.incr(config.seqKey())
          .then((seq) => {
            io.emit('seat', { unit, state: 'free', seq: Number(seq) });
          })
          .catch(() => {
            io.emit('seat', { unit, state: 'free', seq: 0 });
          });
      }
    }
  });

  io.on('connection', async (socket) => {
    try {
      const seats = await getSeatMap();
      socket.emit('seatmap', { event: config.EVENT_ID, total: config.TOTAL_UNITS, seats, seq: seats.seq || 0 });
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

module.exports = { attachSocket, getRedisDbIndex };
