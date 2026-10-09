-- Atomically convert a valid booking-bound hold into a permanent sale.
-- KEYS[1]=sold hash, KEYS[2]=hold key, KEYS[3]=stream
-- KEYS[4]=user holds ZSET, KEYS[5]=hold max key, KEYS[6]=readiness sentinel
-- ARGV[1]=unit, ARGV[2]=userId, ARGV[3]=bookingId, ARGV[4]=eventId
-- returns 'OK' | 'SOLD' | 'EXPIRED' | 'NOT_READY'

if redis.call('EXISTS', KEYS[6]) == 0 then return 'NOT_READY' end

local sold = redis.call('HGET', KEYS[1], ARGV[1])
if sold then
  if sold == ARGV[3] then return 'OK' end
  return 'SOLD'
end

local holder = redis.call('GET', KEYS[2])
if not holder then return 'EXPIRED' end

local sep = string.find(holder, '|', 1, true)
local holderUser = sep and string.sub(holder, 1, sep - 1) or holder
local holderBooking = sep and string.sub(holder, sep + 1) or ''
if holderUser ~= ARGV[2] or (holderBooking ~= '' and holderBooking ~= ARGV[3]) then
  return 'EXPIRED'
end

redis.call('DEL', KEYS[2], KEYS[5])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('XADD', KEYS[3], '*', 'unit', ARGV[1], 'user', ARGV[2], 'bookingId', ARGV[3], 'event', ARGV[4])
return 'OK'