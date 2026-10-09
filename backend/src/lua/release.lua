-- release.lua: give a held seat back, but only if the caller is the one holding it.
-- KEYS[1]=hold key, KEYS[2]=user holds ZSET, KEYS[3]=hold max key
-- ARGV[1]=userId, ARGV[2]=unit
-- returns 1 if released else 0

if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[3])
  redis.call('ZREM', KEYS[2], ARGV[2])
  return 1
end
return 0
