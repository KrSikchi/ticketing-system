-- hold.lua: atomically place (or refresh) a temporary hold on one seat.
-- Checks readiness sentinel, sold hash, and existing hold ownership.
-- KEYS[1]=ready key, KEYS[2]=sold hash, KEYS[3]=hold key
-- ARGV[1]=unit, ARGV[2]=userId, ARGV[3]=ttlMs, ARGV[4]=bookingId (optional)
-- returns 'OK' | 'SOLD' | 'HELD' | 'NOT_READY'

-- 1. Redis data readiness check: fail closed if Postgres rehydration is not complete.
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'NOT_READY'
end

-- 2. Sold check: if seat is already sold, check if it was sold to this exact booking (idempotent retry).
local sold = redis.call('HGET', KEYS[2], ARGV[1])
if sold then
  if ARGV[4] and ARGV[4] ~= '' and sold == ARGV[4] then
    return 'OK'
  end
  return 'SOLD'
end

-- 3. Check who currently holds the seat (format: "userId" or "userId|bookingId").
local holderVal = redis.call('GET', KEYS[3])
if holderVal then
  local sep = string.find(holderVal, '|', 1, true)
  local holderUser = sep and string.sub(holderVal, 1, sep - 1) or holderVal
  if holderUser ~= ARGV[2] then
    return 'HELD'
  end
end

-- 4. Seat is free or owned by this user: write hold with composite value and TTL.
local holdValue = (ARGV[4] and ARGV[4] ~= '') and (ARGV[2] .. '|' .. ARGV[4]) or ARGV[2]
redis.call('SET', KEYS[3], holdValue, 'PX', ARGV[3])

return 'OK'
