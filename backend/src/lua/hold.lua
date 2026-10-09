-- hold.lua: atomically place (or refresh) a temporary hold on one seat.
-- KEYS[1]=sold hash, KEYS[2]=hold key, KEYS[3]=ready key, KEYS[4]=user holds ZSET, KEYS[5]=hold max key
-- ARGV[1]=unit, ARGV[2]=userId, ARGV[3]=ttlMs, ARGV[4]=maxHoldsPerUser, ARGV[5]=maxHoldTotalMs
-- returns 'OK' | 'SOLD' | 'HELD' | 'NOT_READY' | 'LIMIT'

if redis.call('EXISTS', KEYS[3]) == 0 then return 'NOT_READY' end
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 'SOLD' end
local holder = redis.call('GET', KEYS[2])
if holder and holder ~= ARGV[2] then return 'HELD' end

local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local ttlMs = tonumber(ARGV[3])
local maxHolds = tonumber(ARGV[4])
local maxTotalMs = tonumber(ARGV[5])

redis.call('ZREMRANGEBYSCORE', KEYS[4], '-inf', now)

local grantTtl = ttlMs
if holder == ARGV[2] then
  local rem = redis.call('PTTL', KEYS[5])
  if rem <= 0 then
    redis.call('DEL', KEYS[2])
    redis.call('ZREM', KEYS[4], ARGV[1])
    return 'LIMIT'
  end
  if rem < grantTtl then grantTtl = rem end
else
  if redis.call('ZCARD', KEYS[4]) >= maxHolds then return 'LIMIT' end
  redis.call('DEL', KEYS[5])
  redis.call('SET', KEYS[5], ARGV[2], 'PX', maxTotalMs, 'NX')
  if maxTotalMs < grantTtl then grantTtl = maxTotalMs end
end

redis.call('SET', KEYS[2], ARGV[2], 'PX', grantTtl)
redis.call('ZADD', KEYS[4], now + grantTtl, ARGV[1])
if redis.call('PTTL', KEYS[4]) < grantTtl then
  redis.call('PEXPIRE', KEYS[4], grantTtl)
end
return 'OK'
