// POST /hold and POST /release - temporarily lock a seat or hand it back early.
'use strict';

const express = require('express');
const config = require('../config');
const { holdSeat, releaseSeat } = require('../services/inventory');
const identify = require('../middleware/identify');
const rateLimit = require('../middleware/rateLimit');
const { validateUnit, validateBookingId } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

router.post('/hold', identify, rateLimit, validateUnit, validateBookingId({ optional: true }), asyncHandler(async (req, res) => {
  const bookingId = req.bookingId || '';
  const status = await holdSeat(req.unit, req.userId, bookingId);
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

// POST /release {unit, bookingId?} -> 200 {released:true|false}
router.post('/release', identify, rateLimit, validateUnit, validateBookingId({ optional: true }), asyncHandler(async (req, res) => {
  const bookingId = req.bookingId || '';
  const released = await releaseSeat(req.unit, req.userId, bookingId);
  res.status(200).json({ released });
}));

module.exports = router;
