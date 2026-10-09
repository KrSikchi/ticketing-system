-- Release a held seat only if the caller owns it and, when provided, the booking matches.
-- KEYS[1]=hold key, KEYS[2]=user holds ZSET, KEYS[3]=hold max key
-- ARGV[1]=userId, ARGV[2]=bookingId (optional), ARGV[3]=unit
-- returns 1 if released else 0

local holder = redis.call('GET', KEYS[1])
if not holder then return 0 end

local sep = string.find(holder, '|', 1, true)
local holderUser = sep and string.sub(holder, 1, sep - 1) or holder
local holderBooking = sep and string.sub(holder, sep + 1) or ''
if holderUser ~= ARGV[1] then return 0 end
if ARGV[2] and ARGV[2] ~= '' and holderBooking ~= ARGV[2] then return 0 end

redis.call('DEL', KEYS[1], KEYS[3])
redis.call('ZREM', KEYS[2], ARGV[3])
return 1