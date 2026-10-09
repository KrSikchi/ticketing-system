-- pay_begin.lua  KEYS: sold, hold, session   ARGV: unit, userId, holdExtendMs, sessionExtendMs
if redis.call('EXISTS',KEYS[3])==0 then return {'NO_SESSION'} end
if redis.call('HGET',KEYS[3],'user')~=ARGV[2] then return {'FORBIDDEN'} end
if redis.call('HEXISTS',KEYS[3],'lock')==1 then return {'DUP', redis.call('HGET',KEYS[3],'status')} end
if redis.call('HEXISTS',KEYS[1],ARGV[1])==1 then return {'SOLD'} end
if redis.call('GET',KEYS[2])~=ARGV[2] then return {'EXPIRED'} end
redis.call('HSET',KEYS[3],'lock','1')
if redis.call('PTTL',KEYS[2]) < tonumber(ARGV[3]) then redis.call('PEXPIRE',KEYS[2],ARGV[3]) end
redis.call('PEXPIRE',KEYS[3],ARGV[4])
return {'GO'}
