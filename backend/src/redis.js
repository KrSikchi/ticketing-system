// Redis connectivity: the shared main client (normal commands + Lua), a factory for dedicated
// connections (Pub/Sub subscriber, blocking XREADGROUP readers), Lua script registration via
// defineCommand, a waitUntilReady helper and a connection-error classifier used to "fail closed" (503).
'use strict';

const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');
const config = require('./config');

const LUA_DIR = path.join(__dirname, 'lua');

/** The four atomic scripts and how many KEYS each one takes (ioredis sends EVALSHA, falls back to EVAL). */
const SCRIPTS = {
  hold: { numberOfKeys: 5, lua: fs.readFileSync(path.join(LUA_DIR, 'hold.lua'), 'utf8') },
  confirm: { numberOfKeys: 5, lua: fs.readFileSync(path.join(LUA_DIR, 'confirm.lua'), 'utf8') },
  release: { numberOfKeys: 3, lua: fs.readFileSync(path.join(LUA_DIR, 'release.lua'), 'utf8') },
  bucket: { numberOfKeys: 1, lua: fs.readFileSync(path.join(LUA_DIR, 'bucket.lua'), 'utf8') },
  pay_begin: { numberOfKeys: 3, lua: fs.readFileSync(path.join(LUA_DIR, 'pay_begin.lua'), 'utf8') },
  pay_finish: { numberOfKeys: 1, lua: fs.readFileSync(path.join(LUA_DIR, 'pay_finish.lua'), 'utf8') },
};

/**
 * Connection options shared by every client:
 *  - enableOfflineQueue:false -> while disconnected, commands reject IMMEDIATELY ("Stream isn't
 *    writeable") instead of piling up. That is what lets the API answer 503 quickly (fail closed).
 *  - maxRetriesPerRequest:1   -> an in-flight command is re-sent at most once after a reconnect.
 *  - retryStrategy            -> reconnect forever, backing off 200ms, 400ms, ... capped at 2s.
 */
const BASE_OPTIONS = {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  retryStrategy: (times) => Math.min(times * 200, 2000),
};

/** Register hold/confirm/release/bucket as redis.hold(...), redis.confirm(...), etc. */
function defineScripts(client) {
  for (const [name, { numberOfKeys, lua }] of Object.entries(SCRIPTS)) {
    client.defineCommand(name, { numberOfKeys, lua });
  }
}

/**
 * Log connect / error / close once per connection cycle. ioredis emits error+close on every
 * reconnect attempt (every 200ms-2s during an outage), which would otherwise flood the logs.
 */
function attachLogging(client, label) {
  let errorLogged = false;
  let closeLogged = false;
  client.on('connect', () => {
    console.log(`[redis:${label}] connected to ${config.REDIS_URL}`);
    errorLogged = false;
    closeLogged = false;
  });
  client.on('error', (err) => {
    if (errorLogged) return;
    errorLogged = true;
    console.error(`[redis:${label}] error: ${err.message} (will keep retrying)`);
  });
  client.on('close', () => {
    if (closeLogged) return;
    closeLogged = true;
    console.warn(`[redis:${label}] connection closed`);
  });
}

/**
 * Factory: a NEW connection with the scripts registered and quiet logging attached.
 * Use it for anything that must not share the main connection: Pub/Sub subscribers (a subscribed
 * connection cannot run normal commands) and blocking XREADGROUP loops (a blocked connection
 * would stall every other command queued behind it).
 */
function createRedis(label = 'extra', overrides = {}) {
  const client = new Redis(config.REDIS_URL, { ...BASE_OPTIONS, ...overrides });
  defineScripts(client);
  attachLogging(client, label);
  return client;
}

/** Resolves once the client is 'ready' (immediately if it already is). Rejects only if the client ends. */
function waitUntilReady(client) {
  if (client.status === 'ready') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onReady = () => { cleanup(); resolve(); };
    const onEnd = () => { cleanup(); reject(new Error('Redis connection ended before becoming ready')); };
    const cleanup = () => { client.off('ready', onReady); client.off('end', onEnd); };
    client.once('ready', onReady);
    client.once('end', onEnd);
  });
}

/** Error messages / codes that mean "Redis is not reachable right now" (-> HTTP 503, never 500). */
const CONNECTION_ERROR_PATTERNS = [
  "Stream isn't writeable",          // enableOfflineQueue:false while disconnected
  'Connection is closed',
  'Reached the max retries per request limit',
  'Command timed out',
  'LOADING',                         // Redis replaying its AOF right after a restart
  'READONLY',                        // talking to a replica after a failover
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH',
];

/** True when an error is a Redis connectivity problem rather than a bug in our code. */
function isConnectionError(err) {
  if (!err) return false;
  if (err.name === 'MaxRetriesPerRequestError') return true;
  const text = `${err.code || ''} ${err.message || ''}`;
  return CONNECTION_ERROR_PATTERNS.some((p) => text.includes(p));
}

/** The one shared client every API process / worker uses for non-blocking commands and Lua. */
const redis = createRedis('main');

module.exports = { redis, createRedis, waitUntilReady, isConnectionError };
