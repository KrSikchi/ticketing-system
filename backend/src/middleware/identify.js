// Identity middleware: every booking request must carry an "x-user-id" header (the load test sends
// "user-<n>"). There is no real auth in this hackathon build; the id is what hold keys, payment
// sessions and rate-limit buckets are scoped by. Attaches req.userId.
'use strict';

const MAX_LEN = 128;

function identify(req, res, next) {
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

module.exports = identify;
