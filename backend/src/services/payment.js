// Mock payment gateway (no real money). A payment "session" is a Redis hash pay:<bookingId>
// {user, unit, status, lock, paidAt} with a TTL. `pay()` is protected by an HSETNX lock so a
// double click can never charge twice, and `settle()` turns a payment result into a seat outcome.
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
  // The user must hold the seat right now (hold.lua wrote their id into the hold key).
  const holder = await redis.get(config.holdKey(unit));
  if (holder !== userId) return { error: 'NO_HOLD' };

  const key = config.payKey(bookingId);
  const existing = await getSession(bookingId);
  if (existing) {
    // Same user & seat -> a retry, hand back the existing session. Otherwise the client reused a
    // bookingId that belongs to a different booking; refuse rather than mixing them up.
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
 *   status 'PENDING' | 'PAID' | 'FAILED' | 'REFUND' - stored result when another call already charged
 *   status 'NO_SESSION'       - unknown / expired bookingId
 */
async function pay(bookingId) {
  const key = config.payKey(bookingId);
  const session = await getSession(bookingId);
  if (!session) return { status: 'NO_SESSION' };

  // Exactly one caller wins the lock; every duplicate click gets the stored status instead of a 2nd charge.
  const lock = await redis.hsetnx(key, 'lock', '1');
  if (lock === 0) {
    const current = await getSession(bookingId);
    if (!current) return { status: 'NO_SESSION' };
    return { status: current.status, user: current.user, unit: current.unit };
  }

  // Edge case: the session expired between getSession() and HSETNX, so HSETNX created a stray
  // hash with no TTL. A legitimate session always has a TTL (PTTL >= 0) -> clean up and bail out.
  const ttl = await redis.pttl(key);
  if (ttl < 0) {
    await redis.del(key);
    return { status: 'NO_SESSION' };
  }

  // Simulate the gateway round-trip and its success/failure decision.
  await sleep(config.PAYMENT_DELAY_MS);
  const success = Math.random() >= config.PAYMENT_FAIL_RATE;

  if (success) {
    // Keep PAID sessions around for PAID_SESSION_TTL_MS so the reconciler can audit them.
    await redis.multi()
      .hset(key, 'status', 'PAID', 'paidAt', String(Date.now()))
      .pexpire(key, config.PAID_SESSION_TTL_MS)
      .exec();
    return { status: 'PAID', user: session.user, unit: session.unit };
  }

  await redis.hset(key, 'status', 'FAILED');
  return { status: 'FAILED', user: session.user, unit: session.unit };
}

/**
 * Run the payment for a session and apply the result to the seat inventory.
 * Returns { outcome, unit, bookingId } where outcome is one of:
 *   BOOKED | SOLD | EXPIRED | PAYMENT_FAILED | PENDING | NO_SESSION | FORBIDDEN
 * Shared by POST /pay and POST /book so both endpoints behave identically.
 */
async function settle(userId, bookingId) {
  const result = await pay(bookingId);
  if (result.status === 'NO_SESSION') return { outcome: 'NO_SESSION', bookingId };
  // Only the user who created the session may settle it (never confirm someone else's seat).
  if (result.user !== userId) return { outcome: 'FORBIDDEN', bookingId };

  const unit = Number(result.unit);

  if (result.status === 'PAID') {
    const confirmed = await confirmSeat(unit, userId, bookingId);
    if (confirmed === 'OK') return { outcome: 'BOOKED', unit, bookingId };
    // Paid but the seat cannot be delivered (hold expired / someone else got it): refund.
    await setStatus(bookingId, 'REFUND');
    return { outcome: confirmed === 'SOLD' ? 'SOLD' : 'EXPIRED', unit, bookingId };
  }

  if (result.status === 'FAILED') {
    // Give the seat back immediately so other buyers can take it.
    await releaseSeat(unit, userId);
    return { outcome: 'PAYMENT_FAILED', unit, bookingId };
  }

  if (result.status === 'REFUND') return { outcome: 'EXPIRED', unit, bookingId }; // already refunded
  return { outcome: 'PENDING', unit, bookingId }; // another request is mid-payment for this bookingId
}

module.exports = { createSession, pay, settle, getSession, setStatus };
