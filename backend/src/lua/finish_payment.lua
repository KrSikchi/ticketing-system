-- finish_payment.lua: atomically record gateway payment result only if session still exists.
-- KEYS[1]=payKey
-- ARGV[1]=status ('PAID' | 'FAILED'), ARGV[2]=timestampMs, ARGV[3]=ttlMs
-- returns 'OK' | 'NO_SESSION'

if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'NO_SESSION'
end

if ARGV[1] == 'PAID' then
  redis.call('HSET', KEYS[1], 'status', 'PAID', 'paidAt', ARGV[2])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]))
else
  redis.call('HSET', KEYS[1], 'status', 'FAILED')
  redis.call('HDEL', KEYS[1], 'lock')
end

return 'OK'
