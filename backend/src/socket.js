// Live seat-state fan-out over Socket.IO and Redis Pub/Sub/keyspace notifications.
'use strict';

const { Server } = require('socket.io');
const config = require('./config');
const { redis, createRedis } = require('./redis');
const { getSeatMap, invalidateSeatMapCache } = require('./services/inventory');

function getRedisDbIndex(redisUrl) {
  try {
    const parsed = new URL(redisUrl);
    const pathPart = (parsed.pathname || '').replace(/^\/+/, '');
    if (pathPart && /^\d+$/.test(pathPart)) return Number(pathPart);
  } catch (_) {
    /* Ignore malformed URLs and use Redis database zero. */
  }
  return 0;
}

function attachSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
    serveClient: false,
  });

  const subscriber = createRedis('subscriber');
  const expiredChannel = `__keyevent@${getRedisDbIndex(config.REDIS_URL)}__:expired`;
  const holdPrefix = config.holdKey('');

  subscriber.on('ready', () => {
    redis.config('SET', 'notify-keyspace-events', 'Ex').catch(() => {});
    subscriber.subscribe(config.channel, expiredChannel).catch((err) => {
      console.warn(`[socket] subscribe failed: ${err.message}`);
    });
  });

  subscriber.on('message', (channel, message) => {
    if (channel === config.channel) {
      try {
        const event = JSON.parse(message);
        invalidateSeatMapCache();
        io.emit('seat', event);
      } catch (_) {
        /* Ignore malformed messages. */
      }
      return;
    }

    if (channel !== expiredChannel || typeof message !== 'string' || !message.startsWith(holdPrefix)) return;
    const unit = Number(message.slice(holdPrefix.length));
    if (!Number.isInteger(unit) || unit < 1 || unit > config.TOTAL_UNITS) return;

    invalidateSeatMapCache();
    redis.incr(config.seqKey())
      .then((seq) => io.emit('seat', { unit, state: 'free', seq: Number(seq), ts: Date.now() }))
      .catch(() => io.emit('seat', { unit, state: 'free', seq: 0, ts: Date.now() }));
  });

  io.on('connection', async (socket) => {
    try {
      const seats = await getSeatMap();
      socket.emit('seatmap', {
        event: config.EVENT_ID,
        total: config.TOTAL_UNITS,
        seats,
        seq: seats.seq || 0,
        version: Date.now(),
      });
    } catch (_) {
      socket.emit('seatmap_error', { error: 'SERVICE_UNAVAILABLE' });
    }
  });

  async function close() {
    await new Promise((resolve) => io.close(() => resolve()));
    await subscriber.quit().catch(() => subscriber.disconnect());
  }

  return { io, close };
}

module.exports = { attachSocket, getRedisDbIndex };