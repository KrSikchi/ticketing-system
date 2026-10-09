-- release.lua: release a held seat only if the caller owns the hold.
-- KEYS[1]=hold key
-- ARGV[1]=userId, ARGV[2]=bookingId (optional)
-- returns 1 if released else 0

local holderVal = redis.call('GET', KEYS[1])
if not holderVal then
  return 0
end

local sep = string.find(holderVal, '|', 1, true)
local holderUser = sep and string.sub(holderVal, 1, sep - 1) or holderVal
local holderBooking = sep and string.sub(holderVal, sep + 1) or ''

-- Not owned by this user
if holderUser ~= ARGV[1] then
  return 0
end

-- If bookingId was specified and hold contains a different bookingId, do NOT delete.
-- This protects against replayed payment failure / release requests destroying a user's newer hold.
if ARGV[2] and ARGV[2] ~= '' and holderBooking ~= '' and holderBooking ~= ARGV[2] then
  return 0
end

redis.call('DEL', KEYS[1])
return 1
