// Mock payment gateway (no real money). A payment "session" is a Redis hash pay:<bookingId>
// {user, unit, status, lock, paidAt} with a TTL. `pay()` uses atomic begin_payment / finish_payment
// scripts to verify hold ownership, prevent double charges, and eliminate mid-charge session expiration.
'use strict';

const config = require('../config');
const { redis } = require('../redis');
const { confirmSeat, releaseSeat } = require('./inventory');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read a session hash; returns null when it does not exist (never created or expired). */
async function getSession(bookingId) {
  const session = await redis.hgetall(config.payKey(bookingId));
  return session && session.status ? session : null;
}

/** Overwrite the status field (e.g. 'REFUND'); keeps the key's existing TTL. */
async function setStatus(bookingId, status) {
  await redis.hset(config.payKey(bookingId), 'status', status);
}

/**
 * Create a PENDING payment session for a seat the user currently holds.
 * Returns { status, unit, user, bookingId } or { error: 'NO_HOLD' | 'BOOKING_ID_CONFLICT' }.
 * Idempotent: calling it again with the same bookingId returns the existing session.
 */
async function createSession(userId, unit, bookingId) {
  const holderVal = await redis.get(config.holdKey(unit));
  if (!holderVal) return { error: 'NO_HOLD' };

  const sep = holderVal.indexOf('|');
  const holderUser = sep !== -1 ? holderVal.slice(0, sep) : holderVal;
  if (holderUser !== userId) return { error: 'NO_HOLD' };

  const key = config.payKey(bookingId);
  const existing = await getSession(bookingId);
  if (existing) {
    if (existing.user === userId && Number(existing.unit) === Number(unit)) {
      return { status: existing.status, unit: Number(unit), user: userId, bookingId };
    }
    return { error: 'BOOKING_ID_CONFLICT' };
  }

  // HSET + PEXPIRE in one MULTI so the session can never exist without a TTL.
  await redis.multi()
    .hset(key, { user: userId, unit: String(unit), status: 'PENDING' })
    .pexpire(key, config.PAY_SESSION_TTL_MS)
    .exec();

  return { status: 'PENDING', unit: Number(unit), user: userId, bookingId };
}

/**
 * Charge the mock gateway for a session. Returns { status, user, unit }:
 *   status 'PAID' | 'FAILED'  - decided by this call
 *   status 'PENDING' | 'PAID' | 'FAILED' | 'REFUND' | 'NO_HOLD' - stored / atomic validation result
 *   status 'NO_SESSION' | 'FORBIDDEN'
 */
async function pay(bookingId, userId) {
  const session = await getSession(bookingId);
  if (!session) return { status: 'NO_SESSION' };
  if (userId && session.user !== userId) return { status: 'FORBIDDEN' };

  const unit = Number(session.unit);
  const targetUser = userId || session.user;

  // Extend hold and payment TTL to comfortably cover payment gateway delay + buffer
  const extendHoldMs = Math.max(config.HOLD_TTL_MS, config.PAYMENT_DELAY_MS + 30000);
  const extendPayMs = Math.max(config.PAY_SESSION_TTL_MS, config.PAYMENT_DELAY_MS + 30000);

  // Atomically check hold ownership, lock session, and extend TTL
  const beginResult = await redis.begin_payment(
    config.payKey(bookingId),
    config.holdKey(unit),
    targetUser,
    bookingId,
    extendHoldMs,
    extendPayMs,
  );

  if (beginResult === 'LOCKED') {
    const current = await getSession(bookingId);
    return { status: current ? current.status : 'PENDING', user: session.user, unit };
  }
  if (beginResult === 'NO_SESSION' || beginResult === 'FORBIDDEN') {
    return { status: beginResult };
  }
  if (beginResult === 'NO_HOLD') {
    return { status: 'NO_HOLD', user: session.user, unit };
  }
  if (beginResult !== 'OK') {
    // Already in a terminal status: 'PAID' | 'FAILED' | 'REFUND'
    return { status: beginResult, user: session.user, unit };
  }

  // Simulate the gateway round-trip
  await sleep(config.PAYMENT_DELAY_MS);
  const success = Math.random() >= config.PAYMENT_FAIL_RATE;

  if (success) {
    await redis.finish_payment(
      config.payKey(bookingId),
      'PAID',
      String(Date.now()),
      config.PAID_SESSION_TTL_MS,
    );
    return { status: 'PAID', user: session.user, unit };
  }

  await redis.finish_payment(
    config.payKey(bookingId),
    'FAILED',
    '0',
    config.PAY_SESSION_TTL_MS,
  );
  return { status: 'FAILED', user: session.user, unit };
}

/**
 * Run the payment for a session and apply the result to the seat inventory.
 * Returns { outcome, unit, bookingId } where outcome is one of:
 *   BOOKED | SOLD | EXPIRED | PAYMENT_FAILED | PENDING | NO_SESSION | FORBIDDEN | NOT_READY
 */
async function settle(userId, bookingId) {
  const result = await pay(bookingId, userId);
  if (result.status === 'NO_SESSION') return { outcome: 'NO_SESSION', bookingId };
  if (result.status === 'FORBIDDEN') return { outcome: 'FORBIDDEN', bookingId };
  if (result.status === 'NO_HOLD') return { outcome: 'EXPIRED', unit: result.unit, bookingId };

  const unit = Number(result.unit);

  if (result.status === 'PAID') {
    const confirmed = await confirmSeat(unit, userId, bookingId);
    if (confirmed === 'OK') return { outcome: 'BOOKED', unit, bookingId };
    if (confirmed === 'NOT_READY') return { outcome: 'NOT_READY', unit, bookingId };

    // Paid but the seat cannot be delivered (hold expired / taken): mark refund
    await setStatus(bookingId, 'REFUND');
    return { outcome: confirmed === 'SOLD' ? 'SOLD' : 'EXPIRED', unit, bookingId };
  }

  if (result.status === 'FAILED') {
    await releaseSeat(unit, userId, bookingId);
    return { outcome: 'PAYMENT_FAILED', unit, bookingId };
  }

  if (result.status === 'REFUND') return { outcome: 'EXPIRED', unit, bookingId };
  return { outcome: 'PENDING', unit, bookingId };
}

module.exports = { createSession, pay, settle, getSession, setStatus };
