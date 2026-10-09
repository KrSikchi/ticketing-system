-- confirm.lua: atomically convert a valid hold into a permanent sale.
-- Checks readiness, sold hash, verifies hold ownership, marks seat sold and appends to stream.
-- KEYS[1]=ready key, KEYS[2]=sold hash, KEYS[3]=hold key, KEYS[4]=stream
-- ARGV[1]=unit, ARGV[2]=userId, ARGV[3]=bookingId, ARGV[4]=eventId
-- returns 'OK' | 'SOLD' | 'EXPIRED' | 'NOT_READY'

-- 1. Fail closed if system is not ready.
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'NOT_READY'
end

-- 2. Check sold state.
local sold = redis.call('HGET', KEYS[2], ARGV[1])
if sold then
  -- Retry of the same booking: idempotent success.
  if sold == ARGV[3] then return 'OK' end
  -- Sold to another booking: refuse.
  return 'SOLD'
end

-- 3. Verify hold ownership. Value can be "userId" or "userId|bookingId".
local holderVal = redis.call('GET', KEYS[3])
if not holderVal then
  return 'EXPIRED'
end

local sep = string.find(holderVal, '|', 1, true)
local holderUser = sep and string.sub(holderVal, 1, sep - 1) or holderVal
local holderBooking = sep and string.sub(holderVal, sep + 1) or ''

if holderUser ~= ARGV[2] then
  return 'EXPIRED'
end

if holderBooking ~= '' and holderBooking ~= ARGV[3] then
  return 'EXPIRED'
end

-- 4. Hold is valid: delete hold, record sale, and push event to persist stream.
redis.call('DEL', KEYS[3])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
redis.call('XADD', KEYS[4], '*', 'unit', ARGV[1], 'user', ARGV[2], 'bookingId', ARGV[3], 'event', ARGV[4])

return 'OK'
