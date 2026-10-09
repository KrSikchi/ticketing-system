-- confirm.lua: atomically convert a valid hold into a permanent sale.
-- KEYS[1]=sold hash, KEYS[2]=hold key, KEYS[3]=stream, KEYS[4]=user holds ZSET, KEYS[5]=hold max key
-- ARGV[1]=unit, ARGV[2]=userId, ARGV[3]=bookingId, ARGV[4]=eventId
-- returns 'OK' | 'SOLD' | 'EXPIRED'

local sold = redis.call('HGET', KEYS[1], ARGV[1])
if sold then
  if sold == ARGV[3] then return 'OK' end   -- retry of the same booking (idempotent)
  return 'SOLD'
end
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 'EXPIRED' end
redis.call('DEL', KEYS[2], KEYS[5])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
redis.call('XADD', KEYS[3], '*', 'unit', ARGV[1], 'user', ARGV[2], 'bookingId', ARGV[3], 'event', ARGV[4])
return 'OK'
