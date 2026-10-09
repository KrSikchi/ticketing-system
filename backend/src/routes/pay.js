// POST /checkout and POST /pay - stage two of the UI flow: open a payment session for a held seat,
// then charge it. On PAID the seat is confirmed (sold), on FAILED the hold is released.
// sendSettlement() is the single HTTP mapping for payment outcomes and is reused by /book.
'use strict';

const express = require('express');
const { createSession, settle } = require('../services/payment');
const identify = require('../middleware/identify');
const rateLimit = require('../middleware/rateLimit');
const { validateUnit, validateBookingId } = require('../middleware/validate');
const { asyncHandler } = require('../middleware/errorHandler');

const router = express.Router();

/**
 * Translate a settle() result into the HTTP contract shared by /pay and /book:
 *   BOOKED -> 200, SOLD -> 409, EXPIRED -> 410, PAYMENT_FAILED -> 402,
 *   PENDING -> 202 (another call is mid-payment), NO_SESSION -> 404, FORBIDDEN -> 403,
 *   NOT_READY -> 503
 */
function sendSettlement(res, result) {
  const { outcome, unit, bookingId } = result;
  switch (outcome) {
    case 'BOOKED':
      return res.status(200).json({ ok: true, status: 'BOOKED', bookingId, unit });
    case 'SOLD':
      return res.status(409).json({ ok: false, reason: 'SOLD', bookingId, unit });
    case 'EXPIRED':
      return res.status(410).json({ ok: false, reason: 'EXPIRED', bookingId, unit });
    case 'PAYMENT_FAILED':
      return res.status(402).json({ ok: false, reason: 'PAYMENT_FAILED', bookingId, unit });
    case 'PENDING':
      return res.status(202).json({ ok: false, status: 'PENDING', reason: 'PAYMENT_IN_PROGRESS', bookingId, unit });
    case 'FORBIDDEN':
      return res.status(403).json({ ok: false, reason: 'FORBIDDEN', bookingId });
    case 'NOT_READY':
      return res.status(503).json({ ok: false, error: 'SERVICE_UNAVAILABLE', reason: 'NOT_READY', bookingId });
    case 'NO_SESSION':
    default:
      return res.status(404).json({ ok: false, reason: 'NO_SESSION', bookingId });
  }
}

// POST /checkout {unit, bookingId} -> 200 {status:"PENDING"} | 409 {reason:"NO_HOLD"}
router.post('/checkout', identify, rateLimit, validateUnit, validateBookingId(), asyncHandler(async (req, res) => {
  const session = await createSession(req.userId, req.unit, req.bookingId);
  if (session.error) return res.status(409).json({ ok: false, reason: session.error });
  return res.status(200).json({ ok: true, status: session.status, bookingId: req.bookingId, unit: req.unit });
}));

// POST /pay {bookingId} -> 200 BOOKED | 409 SOLD | 410 EXPIRED | 402 PAYMENT_FAILED
router.post('/pay', identify, rateLimit, validateBookingId(), asyncHandler(async (req, res) => {
  const result = await settle(req.userId, req.bookingId);
  return sendSettlement(res, result);
}));

module.exports = router;
// Exposed as a property on the router so routes/book.js can reuse the exact same mapping.
module.exports.sendSettlement = sendSettlement;
