-- pay_finish.lua  KEYS: session   ARGV: status, ttlMs, paidAt
if redis.call('EXISTS',KEYS[1])==0 then return 0 end
if ARGV[3] and ARGV[3] ~= '' then
  redis.call('HSET',KEYS[1],'status',ARGV[1],'paidAt',ARGV[3])
else
  redis.call('HSET',KEYS[1],'status',ARGV[1])
end
redis.call('PEXPIRE',KEYS[1],ARGV[2]) return 1
