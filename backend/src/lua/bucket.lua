-- bucket.lua: token-bucket rate limiter evaluated inside Redis using Redis's OWN clock (TIME),
-- so the three API instances never need synchronised clocks and the check-and-decrement is atomic.
-- KEYS[1]=bucket key, ARGV[1]=capacity, ARGV[2]=refill tokens per second
-- returns 1 if allowed else 0

-- Parse the bucket capacity and refill rate from the arguments.
local cap = tonumber(ARGV[1]); local rate = tonumber(ARGV[2])
-- Ask Redis for the current time: {seconds, microseconds}.
local t = redis.call('TIME')
-- Convert it to integer milliseconds.
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
-- Load the stored token count and the timestamp of the last update (both nil for a new bucket).
local d = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(d[1]); local ts = tonumber(d[2])
-- A bucket we have never seen starts full, as of now.
if tokens == nil then tokens = cap; ts = now end
-- Refill: add (elapsed ms * rate / 1000) tokens, but never above the capacity.
tokens = math.min(cap, tokens + (now - ts) * rate / 1000)
-- Default decision: denied.
local allowed = 0
-- If at least one whole token is available, spend it and allow the request.
if tokens >= 1 then tokens = tokens - 1; allowed = 1 end
-- Persist the new token count and the update timestamp.
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
-- Idle buckets disappear after 60 s so the key space never grows unbounded.
redis.call('PEXPIRE', KEYS[1], 60000)
-- 1 = allowed, 0 = rate limited.
return allowed
