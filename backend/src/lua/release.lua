-- release.lua: give a held seat back, but only if the caller is the one holding it.
-- Doing GET + DEL inside one script guarantees we never delete a hold that meanwhile expired
-- and was re-acquired by a different user.
-- KEYS[1]=hold key, ARGV[1]=userId. Deletes hold only if the caller owns it.
-- returns 1 if released else 0

-- If the current value of the hold key is exactly this user's id, delete the key and report 1.
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) return 1 end
-- Otherwise (no hold, or someone else's hold) touch nothing and report 0.
return 0
