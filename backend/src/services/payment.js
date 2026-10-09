// Mock payment gateway (no real money). A payment "session" is a Redis hash pay:<bookingId>
// {user, unit, status, lock, paidAt} with a TTL. `pay()` uses atomic begin_payment / finish_payment
// scripts to verify hold ownership, prevent double charges, and eliminate mid-charge session expiration.
'use strict';

const config = require('../config');
const { redis } = require('../redis');
const { confirmSeat, releaseSeat } = require('./inventory');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Default mock payment gateway. Carries `idempotencyKey` (bookingId) in the interface.
 */
async function defaultGateway({ idempotencyKey: _idempotencyKey }) {
  await sleep(config.PAYMENT_DELAY_MS);
  return Math.random() >= config.PAYMENT_FAIL_RATE;
}

let gateway = defaultGateway;

/** Inject a custom payment gateway function (used by tests). */
function setGateway(fn) {
  gateway = fn || defaultGateway;
}

/** Read a session hash; returns null when it does not exist (never created or expired). */
async function getSession(bookingId) {
  const session = await redis.hgetall(config.payKey(bookingId));
  return session && session.status ? session : null;
}

/** Guarded status update (e.g. 'REFUND') via pay_finish.lua; never recreates an expired key. */
async function setStatus(bookingId, status) {
  const ttlMs = status === 'PAID' || status === 'REFUND' ? config.PAID_SESSION_TTL_MS : config.PAY_SESSION_TTL_MS;
  const updated = await redis.pay_finish(config.payKey(bookingId), status, String(ttlMs), '');
  if (Number(updated) === 0) {
    console.error(`[payment] ALERT: session ${bookingId} vanished before status update to ${status}`);
  }
  return Number(updated) === 1;
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
<<<<<<< HEAD
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
=======
 * Charge the mock gateway for a session. Returns { status, user, unit, decided }:
 *   status 'PAID' | 'FAILED'  - decided by this call (decided: true)
 *   status 'PENDING' | 'PAID' | 'FAILED' | 'REFUND' - stored result when another call already charged (decided: false)
 *   status 'SOLD' | 'EXPIRED' | 'FORBIDDEN' - pre-charge check failed (decided: false, no charge)
 *   status 'NO_SESSION'       - unknown / expired bookingId
 */
async function pay(bookingId, callerUserId) {
  const key = config.payKey(bookingId);
  const session = await getSession(bookingId);
  if (!session) return { status: 'NO_SESSION', decided: false };

  const effectiveUser = callerUserId !== undefined ? callerUserId : session.user;
  const begin = await redis.pay_begin(
    config.soldKey(),
    config.holdKey(session.unit),
    key,
    String(session.unit),
    String(effectiveUser),
    String(config.PAYMENT_TIMEOUT_MS),
    String(config.PAYMENT_TIMEOUT_MS),
  );
  const code = Array.isArray(begin) ? begin[0] : begin;

  if (code === 'NO_SESSION') return { status: 'NO_SESSION', decided: false };
  if (code === 'FORBIDDEN') return { status: 'FORBIDDEN', user: session.user, unit: session.unit, decided: false };
  if (code === 'DUP') {
    const storedStatus = begin[1] || session.status;
    return { status: storedStatus, user: session.user, unit: session.unit, decided: false };
>>>>>>> 9f16306674823379e99faedf8df29810c8d319a3
  }
  if (code === 'SOLD') return { status: 'SOLD', user: session.user, unit: session.unit, decided: false };
  if (code === 'EXPIRED') return { status: 'EXPIRED', user: session.user, unit: session.unit, decided: false };

<<<<<<< HEAD
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
=======
  // code === 'GO': call the gateway ONLY after hold & session ownership were atomically verified.
  const success = await gateway({
    idempotencyKey: bookingId,
    bookingId,
    user: session.user,
    unit: session.unit,
  });

  if (success) {
    // Keep PAID sessions around for PAID_SESSION_TTL_MS so the reconciler can audit them.
    const finished = await redis.pay_finish(key, 'PAID', String(config.PAID_SESSION_TTL_MS), String(Date.now()));
    if (Number(finished) === 0) {
      console.error(`[payment] ALERT: session ${bookingId} vanished during payment charge for user=${session.user} unit=${session.unit}; proceeding with confirm`);
    }
    return { status: 'PAID', user: session.user, unit: session.unit, decided: true };
  }

  const finished = await redis.pay_finish(key, 'FAILED', String(config.PAY_SESSION_TTL_MS), '');
  if (Number(finished) === 0) {
    console.error(`[payment] ALERT: session ${bookingId} vanished during failed payment charge for user=${session.user} unit=${session.unit}`);
  }
  return { status: 'FAILED', user: session.user, unit: session.unit, decided: true };
>>>>>>> 9f16306674823379e99faedf8df29810c8d319a3
}

/**
 * Run the payment for a session and apply the result to the seat inventory.
 * Returns { outcome, unit, bookingId } where outcome is one of:
 *   BOOKED | SOLD | EXPIRED | PAYMENT_FAILED | PENDING | NO_SESSION | FORBIDDEN | NOT_READY
 */
async function settle(userId, bookingId) {
  const result = await pay(bookingId, userId);
  if (result.status === 'NO_SESSION') return { outcome: 'NO_SESSION', bookingId };
<<<<<<< HEAD
  if (result.status === 'FORBIDDEN') return { outcome: 'FORBIDDEN', bookingId };
  if (result.status === 'NO_HOLD') return { outcome: 'EXPIRED', unit: result.unit, bookingId };
=======
  // Only the user who created the session may settle it (never confirm someone else's seat).
  if (result.status === 'FORBIDDEN' || result.user !== userId) return { outcome: 'FORBIDDEN', bookingId };
>>>>>>> 9f16306674823379e99faedf8df29810c8d319a3

  const unit = Number(result.unit);

  if (result.status === 'SOLD') return { outcome: 'SOLD', unit, bookingId };
  if (result.status === 'EXPIRED') return { outcome: 'EXPIRED', unit, bookingId };

  if (result.status === 'PAID') {
    const confirmed = await confirmSeat(unit, userId, bookingId);
    if (confirmed === 'OK') return { outcome: 'BOOKED', unit, bookingId };
    if (confirmed === 'NOT_READY') return { outcome: 'NOT_READY', unit, bookingId };

    // Paid but the seat cannot be delivered (hold expired / taken): mark refund
    await setStatus(bookingId, 'REFUND');
    return { outcome: confirmed === 'SOLD' ? 'SOLD' : 'EXPIRED', unit, bookingId };
  }

  if (result.status === 'FAILED') {
<<<<<<< HEAD
    await releaseSeat(unit, userId, bookingId);
=======
    // Give the seat back immediately so other buyers can take it - ONLY when this call decided FAILED.
    if (result.decided) {
      await releaseSeat(unit, userId);
    }
>>>>>>> 9f16306674823379e99faedf8df29810c8d319a3
    return { outcome: 'PAYMENT_FAILED', unit, bookingId };
  }

  if (result.status === 'REFUND') return { outcome: 'EXPIRED', unit, bookingId };
  return { outcome: 'PENDING', unit, bookingId };
}

module.exports = { createSession, pay, settle, getSession, setStatus, setGateway };
