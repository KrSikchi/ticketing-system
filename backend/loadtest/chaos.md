# Chaos scenarios (manual)

Five failure drills, each with exact commands and the result you should see. Run them one at a
time from the `backend/` folder with the stack up (`npm run start:all` in terminal A, commands below
in terminal B). Every scenario ends with `npm run verify` printing **PASS** - the invariant under
test is always the same: *Redis sold == Postgres bookings, zero duplicates, never more than 200*.

`start-all` prints the pid of every child it launches, e.g. `[start-all] persist-w1 started (pid 4296)`,
and prints it again after each restart. Use those pids below.

| OS            | kill a process hard        | kill it gracefully        |
|---------------|----------------------------|---------------------------|
| Linux / macOS | `kill -9 <pid>`            | `kill <pid>`              |
| Windows       | `taskkill /PID <pid> /F`   | `taskkill /PID <pid>`     |

Helper used below to read the Redis side quickly:

```bash
docker exec tickets-redis redis-cli XLEN bookings                  # entries not yet processed
docker exec tickets-redis redis-cli XPENDING bookings persisters   # delivered but not acked
docker exec tickets-redis redis-cli HLEN "evt:{e1}:sold"           # seats sold (Redis)
docker exec tickets-pg psql -U postgres -d tickets -c "SELECT COUNT(*) FROM bookings;"
```

---

## 1. Kill persist worker w1 mid-test -> start-all restarts it, counts converge

```bash
npm run reset
npm run loadtest &            # terminal B (PowerShell: Start-Process node loadtest/race.js)
kill -9 <pid of persist-w1>   # within ~1 s, while the test is running
# wait for the load test to finish (~5 s)
npm run verify
```

What you will see in terminal A:

```
[start-all] persist-w1 exited (code=null, signal=SIGKILL); restarting in 1000 ms
[persist-w2] reclaimed 35 pending entries          <- XAUTOCLAIM took over w1's unacked batch
[persist-w2] persisted 9327cb2e-... unit 62 by w2
[start-all] persist-w1 started (pid 3983)
[persist-w1] consuming
```

Expected: load test `200 BOOKED` as usual; verify `Redis sold (200) == Postgres (200)`, **PASS**.
Why it works: w1 died holding entries it had read but not acknowledged. They stayed in the
consumer group's pending list; after 5 s of idleness w2's `XAUTOCLAIM` took them over and
inserted them (`ON CONFLICT DO NOTHING` makes a re-insert of an already persisted entry harmless).

---

## 2. Stop Postgres for ~10 s mid-test -> users keep booking, backlog drains afterwards

```bash
npm run reset
npm run loadtest &
docker stop tickets-pg        # within ~1 s of starting the load test
curl -s localhost:3001/health                 # {"redis":"ok","postgres":"down","port":3001}  (503)
curl -s -X POST localhost:3002/book -H 'content-type: application/json' -H 'x-user-id: me' -d '{"unit":77}'
                                              # answers 409 SOLD / 200 BOOKED - never 503: booking needs only Redis
docker exec tickets-redis redis-cli XLEN bookings             # e.g. 200 -> bookings are queued safely
sleep 10
docker start tickets-pg
npm run verify
```

What you will see in terminal A:

```
[persist-w1] postgres unavailable (connect ECONNREFUSED 127.0.0.1:5432) - entries stay pending, waiting...
[persist-w1] [pg] not reachable (connect ECONNREFUSED 127.0.0.1:5432); retrying every 1000 ms...
...
[persist-w1] postgres is back - resuming
[persist-w1] reclaimed 50 pending entries
[persist-w1] persisted a3bcaa2c-... unit 123 by w1
```

Expected: the load test still reports `200 BOOKED` (the hot path never touches Postgres);
`XLEN bookings` is > 0 while Postgres is down and drops to 0 within a couple of seconds after
`docker start`; verify waits for the drain and prints **PASS** with 200 == 200.
`/health` returns 503 during the outage only to make the degraded dependency visible.

---

## 3. Restart Redis mid-test -> APIs answer 503 briefly, then recover; sold seats rehydrated

```bash
npm run reset
npm run loadtest &
docker restart tickets-redis  # within ~1 s of starting the load test
curl -s -w ' %{http_code}\n' -X POST localhost:3001/book -H 'content-type: application/json' -H 'x-user-id: me' -d '{"unit":3}'
                              # while Redis is down: {"error":"SERVICE_UNAVAILABLE"} 503 - answered in milliseconds
npm run verify                # after the test finished
curl -s localhost:3001/seats | head -c 300
```

What you will see in terminal A (one line per client per outage, no log flood):

```
[api-3001  ] [redis:main] connection closed
[api-3001  ] [redis:main] error: connect ECONNREFUSED 127.0.0.1:6379 (will keep retrying)
[api-3001  ] [api] POST /book -> 503 redis unavailable: Stream isn't writeable and enableOfflineQueue options is false
[api-3001  ] [api] ... and 1631 more requests answered 503 in the last 5 s (redis unavailable)
[api-3001  ] [redis:main] connected to redis://127.0.0.1:6379
[api-3001  ] [rehydrate] event e1: 170 sold seats in Postgres, 0 restored into Redis
[persist-w1] created consumer group persisters on stream bookings     <- only if the stream was lost
```

Expected: users that hit the outage get fast `503 UNAVAILABLE` (fail closed - the engine never
guesses about seats without Redis, and never sells from Postgres); seats sold before the restart
stay sold; verify prints **PASS** with Redis == Postgres (e.g. 170 == 170 - fewer than 200 because
users who got a 503 stop, per the load-test rules).

Because Redis runs with `--appendonly yes --appendfsync always`, a plain restart loses nothing and
rehydrate restores 0 rows. To see rehydrate actually working, destroy the Redis volume:

```bash
docker compose stop redis && docker compose rm -f redis && docker volume rm backend_redis-data
docker compose up -d redis
```

Terminal A then shows `[rehydrate] event e1: 170 sold seats in Postgres, 170 restored into Redis`
(one instance restores, the other two find them already there) and `POST /book` for a sold seat
still answers `409 SOLD`.

Side effects to know about: a user whose request was mid-payment when Redis died keeps a
`PENDING` session with the payment lock set and a hold that expires normally (nobody was charged);
a user who was charged but not confirmed is refunded by the reconciler on its next sweep.

---

## 4. Hold a seat and abandon it with HOLD_TTL_MS=5000 -> bookable again after ~5 s

Start one extra API instance with a short TTL (the running ones keep 90 s):

```bash
HOLD_TTL_MS=5000 PORT=3004 node src/server.js      # PowerShell: $env:HOLD_TTL_MS=5000; $env:PORT=3004; node src/server.js
```

In another terminal:

```bash
curl -s -X POST localhost:3004/hold -H 'content-type: application/json' -H 'x-user-id: alice' -d '{"unit":1}'
# {"ok":true,"unit":1,"expiresInMs":5000}
curl -s -X POST localhost:3002/book -H 'content-type: application/json' -H 'x-user-id: bob' -d '{"unit":1}'
# {"ok":false,"reason":"HELD","unit":1}                    <- any instance sees the hold (it lives in Redis)
curl -s localhost:3003/seats | grep -o '{"unit":1,"state":"[a-z]*"}'
# {"unit":1,"state":"held"}
docker exec tickets-redis redis-cli PTTL "evt:{e1}:hold:1"   # ~4900 - Redis's clock owns the expiry
sleep 6
curl -s localhost:3003/seats | grep -o '{"unit":1,"state":"[a-z]*"}'
# {"unit":1,"state":"free"}
curl -s -X POST localhost:3002/book -H 'content-type: application/json' -H 'x-user-id: bob' -d '{"unit":1}'
# {"ok":true,"status":"BOOKED","bookingId":"...","unit":1}
curl -s -X POST localhost:3004/checkout -H 'content-type: application/json' -H 'x-user-id: alice' -d '{"unit":1,"bookingId":"33333333-3333-4333-8333-333333333333"}'
# {"ok":false,"reason":"NO_HOLD"}                           <- alice's hold is gone
```

Variant - pay too late (hold expires between /checkout and /pay):

```bash
curl -s -X POST localhost:3004/hold     -H 'content-type: application/json' -H 'x-user-id: carol' -d '{"unit":2}'
curl -s -X POST localhost:3004/checkout -H 'content-type: application/json' -H 'x-user-id: carol' -d '{"unit":2,"bookingId":"44444444-4444-4444-8444-444444444444"}'
sleep 6
curl -s -X POST localhost:3001/pay      -H 'content-type: application/json' -H 'x-user-id: carol' -d '{"bookingId":"44444444-4444-4444-8444-444444444444"}'
# 410 {"ok":false,"reason":"EXPIRED",...}  and  redis-cli HGET pay:44444444-4444-4444-8444-444444444444 status  -> REFUND
```

Expected: nobody ever compares timestamps; the seat frees itself exactly when Redis expires the key.

---

## 5. Kill one API instance -> the other two continue

```bash
npm run reset
npm run loadtest &
kill -9 <pid of api-3002>     # within ~1 s
# wait for the test to finish
npm run verify
```

What you will see:

```
[start-all] api-3002 exited (code=null, signal=SIGKILL); restarting in 1000 ms
[start-all] api-3002 started (pid 5433)
[api-3002  ] [rehydrate] event e1: 179 sold seats in Postgres, 0 restored into Redis
[api-3002  ] listening on http://0.0.0.0:3002
...
[reconciler] refunded 9bf0a9ee-... (user user-263, unit 196 is not sold)    <- ~30-60 s later
```

Expected: the load test reports `NETWORK_ERROR` for roughly one third of the requests sent while
3002 was down (race.js round-robins blindly across the three ports - it has no health-aware
failover on purpose, a load balancer would do that in production) and `BOOKED` + `SOLD` for the
rest; 3001/3003 never hiccup; verify prints **PASS** with Redis == Postgres.

Two consistent edge states appear, both handled:

* requests whose `confirm.lua` had already executed when the process died: the seat is sold and the
  booking is in the stream, only the HTTP response was lost. A client that retries `POST /pay` with
  its bookingId gets `200 BOOKED` back (idempotent confirm), which is why Redis/Postgres can show a
  few more sold seats than the load test counted as `200 BOOKED`;
* requests killed between "payment PAID" and `confirm`: the user was charged without a seat. The
  reconciler finds `PAID` sessions older than 30 s whose seat is not sold to them and marks them
  `REFUND` (see the log line above).
