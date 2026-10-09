// Last-resort error handling. Redis connectivity errors become 503 SERVICE_UNAVAILABLE (fail closed:
// we never guess about seats when Redis is away), malformed requests become 4xx, anything else 500.
// Also exports asyncHandler(), which forwards rejected promises from async routes to this handler
// so a failed request can never crash the process.
'use strict';

const { isConnectionError } = require('../redis');

/** Wrap an async Express handler so rejections reach next(err) instead of becoming unhandled. */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// During a Redis outage thousands of requests fail per second. Log the first one of every 5 s
// window immediately and a one-line summary ("... and N more") when the window closes.
const OUTAGE_LOG_WINDOW_MS = 5000;
let outageWindowOpen = false;
let outageSuppressed = 0;
function logUnavailable(req, err) {
  if (outageWindowOpen) {
    outageSuppressed += 1;
    return;
  }
  console.warn(`[api] ${req.method} ${req.originalUrl} -> 503 redis unavailable: ${err.message}`);
  outageWindowOpen = true;
  outageSuppressed = 0;
  const timer = setTimeout(() => {
    outageWindowOpen = false;
    if (outageSuppressed > 0) {
      console.warn(`[api] ... and ${outageSuppressed} more requests answered 503 in the last ${OUTAGE_LOG_WINDOW_MS / 1000} s (redis unavailable)`);
    }
    outageSuppressed = 0;
  }, OUTAGE_LOG_WINDOW_MS);
  timer.unref(); // a pending log summary must never keep a shutting-down process alive
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return; // response already on the wire; nothing sensible left to do

  // body-parser errors (invalid JSON, payload too large, ...) carry a 4xx status.
  if (err && (err.type === 'entity.parse.failed' || (err.status >= 400 && err.status < 500))) {
    return res.status(err.status || 400).json({ error: 'BAD_REQUEST', message: err.message });
  }

  if (isConnectionError(err)) {
    logUnavailable(req, err);
    return res.status(503).json({ error: 'SERVICE_UNAVAILABLE' });
  }

  console.error(`[api] ${req.method} ${req.originalUrl} -> 500:`, err && err.stack ? err.stack : err);
  return res.status(500).json({ error: 'INTERNAL_ERROR' });
}

module.exports = { errorHandler, asyncHandler };
