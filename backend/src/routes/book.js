// POST /book - convenience endpoint: hold + checkout + pay + confirm in ONE
// request. Every outcome is one of: 200 BOOKED, 409 SOLD, 409 HELD, 402 PAYMENT_FAILED,
// 410 EXPIRED, 429 RATE_LIMITED, 503 SERVICE_UNAVAILABLE.
'use strict';

const crypto = require('crypto');
const express = require('express');
const { holdSeat } = require('../services/inventory');
const { createSession, settle } = require('../services/payment');
const identify = require('../middleware/identify');
const rateLimit = require('../middleware/rateLimit');
const { validateUnit, validateBookingId } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errorHandler');
const { sendSettlement } = require('./pay');

const router = express.Router();

router.post('/book', identify, rateLimit, validateUnit, validateBookingId({ optional: true }), asyncHandler(async (req, res) => {
  const { unit, userId } = req;
  const bookingId = req.bookingId || crypto.randomUUID();

  // 1. Atomically take the seat (or learn that it is gone) with composite bookingId tracking.
  const held = await holdSeat(unit, userId, bookingId);
  if (held === 'NOT_READY') {
    return res.status(503).json({ ok: false, error: 'SERVICE_UNAVAILABLE', reason: 'NOT_READY', unit });
  }
  if (held !== 'OK') {
    return res.status(409).json({ ok: false, reason: held, unit }); // 'SOLD' | 'HELD'
  }

  // 2. Open the payment session against the hold we just took.
  const session = await createSession(userId, unit, bookingId);
  if (session.error === 'NO_HOLD') {
    return res.status(410).json({ ok: false, reason: 'EXPIRED', bookingId, unit });
  }
  if (session.error) {
    return res.status(409).json({ ok: false, reason: session.error, bookingId, unit });
  }

  // 3. Charge, then confirm (PAID) or release (FAILED) - identical to POST /pay.
  const result = await settle(userId, bookingId);
  return sendSettlement(res, result);
}));

module.exports = router;
