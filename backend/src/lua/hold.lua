-- hold.lua: atomically place (or refresh) a temporary hold on one seat.
-- Runs inside Redis, so the "is it sold? is it held by someone else? then take it" sequence
-- can never interleave with another client. Expiry is handled purely by the key TTL (Redis clock).
-- KEYS[1]=sold hash, KEYS[2]=hold key
-- ARGV[1]=unit, ARGV[2]=userId, ARGV[3]=ttlMs
-- returns 'OK' | 'SOLD' | 'HELD'

-- If the sold hash already has a field for this unit, the seat is permanently gone: refuse.
if redis.call('HEXISTS', KEYS[1], ARGV[1]) == 1 then return 'SOLD' end
-- Read who currently holds the seat (nil/false if nobody, or if the previous hold expired).
local holder = redis.call('GET', KEYS[2])
-- Someone else holds it and their TTL has not run out yet: refuse.
if holder and holder ~= ARGV[2] then return 'HELD' end
-- Seat is free, or already held by this same user: (re)write the hold with a fresh TTL in ms.
redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
-- Tell the caller the hold is theirs.
return 'OK'
