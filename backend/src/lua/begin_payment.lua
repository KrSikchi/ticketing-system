-- begin_payment.lua: atomically verify hold and session before charging the gateway.
-- Locks the session, checks hold ownership, and extends TTLs so payment never races expiry.
-- KEYS[1]=payKey, KEYS[2]=holdKey
-- ARGV[1]=userId, ARGV[2]=bookingId, ARGV[3]=extendHoldMs, ARGV[4]=extendPayMs
-- returns 'OK' | 'NO_SESSION' | 'FORBIDDEN' | 'NO_HOLD' | 'LOCKED' | 'PAID' | 'FAILED' | 'REFUND'

local sStatus = redis.call('HGET', KEYS[1], 'status')
if not sStatus then
  return 'NO_SESSION'
end

if sStatus ~= 'PENDING' then
  return sStatus
end

local sUser = redis.call('HGET', KEYS[1], 'user')
if sUser ~= ARGV[1] then
  return 'FORBIDDEN'
end

local lock = redis.call('HSETNX', KEYS[1], 'lock', '1')
if lock == 0 then
  return 'LOCKED'
end

local holderVal = redis.call('GET', KEYS[2])
if not holderVal then
  redis.call('HDEL', KEYS[1], 'lock')
  return 'NO_HOLD'
end

local sep = string.find(holderVal, '|', 1, true)
local holderUser = sep and string.sub(holderVal, 1, sep - 1) or holderVal
local holderBooking = sep and string.sub(holderVal, sep + 1) or ''

if holderUser ~= ARGV[1] or (holderBooking ~= '' and holderBooking ~= ARGV[2]) then
  redis.call('HDEL', KEYS[1], 'lock')
  return 'NO_HOLD'
end

-- Both hold and session are verified: extend TTLs to comfortably cover the gateway round-trip.
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[3]))
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[4]))

return 'OK'
