-- confirm.lua: atomically convert a valid hold into a permanent sale.
-- Checks the sold hash, verifies the caller still owns the hold, marks the seat sold and appends a
-- booking note to the stream - all in one indivisible step. Idempotent for retries of the same booking.
-- KEYS[1]=sold hash, KEYS[2]=hold key, KEYS[3]=stream
-- ARGV[1]=unit, ARGV[2]=userId, ARGV[3]=bookingId, ARGV[4]=eventId
-- returns 'OK' | 'SOLD' | 'EXPIRED'

-- Look up which bookingId (if any) already owns this unit in the sold hash.
local sold = redis.call('HGET', KEYS[1], ARGV[1])
-- The seat is already sold...
if sold then
  -- ...to this very booking: a retry of an earlier successful confirm, report success again (idempotent).
  if sold == ARGV[3] then return 'OK' end   -- retry of the same booking (idempotent)
  -- ...to a different booking: refuse, the seat belongs to someone else.
  return 'SOLD'
end
-- Not sold yet. The hold key must still exist AND still carry this user's id; otherwise the hold
-- expired (Redis deleted it) or was taken over by another user after expiry.
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 'EXPIRED' end
-- Hold is valid: remove it (the seat is leaving the "held" state)...
redis.call('DEL', KEYS[2])
-- ...and record the sale: unit -> bookingId in the sold hash (no TTL, this is permanent in Redis).
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
-- Append a booking note to the stream so a persist worker writes it to Postgres asynchronously.
redis.call('XADD', KEYS[3], '*', 'unit', ARGV[1], 'user', ARGV[2], 'bookingId', ARGV[3], 'event', ARGV[4])
-- Report success to the caller.
return 'OK'
