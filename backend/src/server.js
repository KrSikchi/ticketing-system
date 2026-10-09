// Process entry point for ONE API instance. Startup order is deliberate:
// 1) Redis ready  2) Postgres reachable  3) rehydrate sold seats  4) http + Socket.IO  5) listen
// 6) re-run rehydrate on every Redis reconnect  7) graceful shutdown on SIGTERM / SIGINT.
'use strict';

const http = require('http');
const config = require('./config');
const app = require('./app');
const { redis, waitUntilReady } = require('./redis');
const { pool, waitForPostgres } = require('./pg');
const rehydrate = require('./rehydrate');
const { attachSocket } = require('./socket');

const TAG = `[api-${config.PORT}]`;

async function main() {
  console.log(`${TAG} starting (event=${config.EVENT_ID}, units=${config.TOTAL_UNITS}, holdTtl=${config.HOLD_TTL_MS}ms)`);

  // 1. Redis is mandatory: without it we cannot sell anything (fail closed).
  await waitUntilReady(redis);

  // 2. Postgres must be reachable at boot so step 3 can run (it is NOT needed afterwards).
  await waitForPostgres();

  // 3. Make sure every seat sold in Postgres is marked sold in Redis before accepting traffic.
  await rehydrate();

  // 4. HTTP server + live seat events.
  const server = http.createServer(app);
  server.keepAliveTimeout = 65000; // > typical LB / client idle timeout (avoids racing resets)
  server.headersTimeout = 66000;   // must be > keepAliveTimeout
  server.maxConnections = 20000;
  const socket = attachSocket(server);

  // 5. Accept traffic. backlog 4096: a flash sale opens with thousands of simultaneous SYNs, and the
  //    default backlog (511) would silently drop some (clients then stall ~1 s on SYN retransmit).
  //    The kernel caps this at net.core.somaxconn.
  await new Promise((resolve) => server.listen({ port: config.PORT, backlog: 4096 }, resolve));
  console.log(`${TAG} listening on http://0.0.0.0:${config.PORT}`);

  // 6. After every reconnect (e.g. `docker restart tickets-redis`) rebuild the sold hash again.
  let shuttingDown = false;
  redis.on('ready', () => {
    rehydrate.rehydrateWithRetry({ shouldStop: () => shuttingDown, tag: TAG });
  });

  // 7. Graceful shutdown: stop accepting, drain, close dependencies, exit.
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${TAG} ${signal} received, shutting down`);
    const forceExit = setTimeout(() => process.exit(0), 5000).unref();
    try {
      await new Promise((resolve) => server.close(() => resolve()));
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await socket.close();
      await redis.quit().catch(() => redis.disconnect());
      await pool.end().catch(() => {});
    } catch (err) {
      console.error(`${TAG} error during shutdown: ${err.message}`);
    }
    clearTimeout(forceExit);
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// A single bad request must never take the instance down: log and keep serving.
process.on('unhandledRejection', (reason) => {
  console.error(`${TAG} unhandled rejection:`, reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  // State may be inconsistent after an uncaught exception; exit and let start-all restart us.
  console.error(`${TAG} uncaught exception, exiting:`, err && err.stack ? err.stack : err);
  process.exit(1);
});

main().catch((err) => {
  console.error(`${TAG} failed to start: ${err.stack || err.message}`);
  process.exit(1);
});
