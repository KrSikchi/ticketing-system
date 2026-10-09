// Request validation: `unit` must be an integer in 1..TOTAL_UNITS (-> req.unit) and `bookingId`,
// where present, must be a UUID (-> req.bookingId, lower-cased). Rejecting non-UUIDs here matters:
// bookings.booking_id is a UUID column, so garbage would poison the persist queue later.
'use strict';

const config = require('../config');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Body must contain unit: integer (or integer string) between 1 and TOTAL_UNITS. */
function validateUnit(req, res, next) {
  const body = req.body || {};
  const raw = body.unit;
  const unit = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (!Number.isInteger(unit) || unit < 1 || unit > config.TOTAL_UNITS) {
    return res.status(400).json({
      error: 'INVALID_UNIT',
      message: `unit must be an integer between 1 and ${config.TOTAL_UNITS}`,
    });
  }
  req.unit = unit;
  return next();
}

/**
 * Body may/must contain bookingId: a UUID string.
 * validateBookingId({ optional: true }) is used by /book where the server generates one if absent.
 */
function validateBookingId({ optional = false } = {}) {
  return function bookingIdValidator(req, res, next) {
    const body = req.body || {};
    const raw = body.bookingId;
    if (raw === undefined || raw === null || raw === '') {
      if (optional) return next();
      return res.status(400).json({ error: 'INVALID_BOOKING_ID', message: 'bookingId is required' });
    }
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
      return res.status(400).json({ error: 'INVALID_BOOKING_ID', message: 'bookingId must be a UUID' });
    }
    req.bookingId = raw.toLowerCase();
    return next();
  };
}

module.exports = { validateUnit, validateBookingId };
