// Identity middleware:
// - AUTH_MODE=header (default, for dev and load tests ONLY): reads "x-user-id" header.
// - AUTH_MODE=jwt: verifies Bearer JWT signed with HS256 using JWT_SECRET (timing-safe signature
//   comparison + `exp` check) and sets `req.userId = sub`.
'use strict';

const crypto = require('crypto');
const config = require('../config');

const MAX_LEN = 128;

/** Verify an HS256 JWT and return its `sub` claim, or null if invalid/expired. */
function verifyHs256Jwt(token, secret) {
  if (typeof token !== 'string' || !token || typeof secret !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header;
  let payload;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }

  if (!header || header.alg !== 'HS256') return null;

  const expectedSig = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest();
  let actualSig;
  try {
    actualSig = Buffer.from(sigB64, 'base64url');
  } catch (_) {
    return null;
  }
  if (actualSig.length !== expectedSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;
  if (payload.exp !== undefined) {
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    if (Date.now() / 1000 >= payload.exp) return null;
  }

  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (!sub || sub.length > MAX_LEN) return null;
  return sub;
}

function identify(req, res, next) {
  const mode = process.env.AUTH_MODE || config.AUTH_MODE;
  if (mode === 'jwt') {
    const secret = process.env.JWT_SECRET || config.JWT_SECRET;
    const authHeader = req.get('authorization') || '';
    const token = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : '';
    const sub = verifyHs256Jwt(token, secret);
    if (!sub) {
      return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'valid Bearer JWT is required' });
    }
    req.userId = sub;
    return next();
  }

  const raw = req.get('x-user-id');
  const userId = typeof raw === 'string' ? raw.trim() : '';
  if (!userId) {
    return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'x-user-id header is required' });
  }
  if (userId.length > MAX_LEN) {
    return res.status(400).json({ error: 'INVALID_USER_ID', message: `x-user-id must be <= ${MAX_LEN} chars` });
  }
  req.userId = userId;
  return next();
}

identify.verifyHs256Jwt = verifyHs256Jwt;
module.exports = identify;
