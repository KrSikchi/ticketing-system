// POST /hold and POST /release - the two-step UI flow's first stage: temporarily lock a seat for
// the current user (TTL = HOLD_TTL_MS, enforced by Redis) or hand it back early.
// Decisions are made by hold.lua / release.lua; this file only maps results to HTTP.
'use strict';

const express = require('express');
const config = require('../config');
const { holdSeat, releaseSeat } = require('../services/inventory');
const identify = require('../middleware/identify');
const rateLimit = require('../middleware/rateLimit');
const { validateUnit } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

// POST /hold {unit} -> 200 {ok:true, unit, expiresInMs} | 409 {ok:false, reason:"HELD"|"SOLD"} | 503 {ok:false, reason:"NOT_READY"}
router.post('/hold', identify, rateLimit, validateUnit, asyncHandler(async (req, res) => {
  const status = await holdSeat(req.unit, req.userId);
  if (status === 'OK') {
    return res.status(200).json({ ok: true, unit: req.unit, expiresInMs: config.HOLD_TTL_MS });
  }
  if (status === 'NOT_READY') {
    return res.set('Retry-After', '1').status(503).json({ ok: false, error: 'SERVICE_UNAVAILABLE', reason: 'NOT_READY' });
  }
  if (status === 'LIMIT') {
    return res.status(429).json({ ok: false, error: 'RATE_LIMITED', reason: 'HOLD_LIMIT' });
  }
  return res.status(409).json({ ok: false, reason: status }); // 'HELD' or 'SOLD'
}));

// POST /release {unit} -> 200 {released:true|false}
router.post('/release', identify, rateLimit, validateUnit, asyncHandler(async (req, res) => {
  const released = await releaseSeat(req.unit, req.userId);
  res.status(200).json({ released });
}));

module.exports = router;
