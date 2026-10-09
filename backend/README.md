# Flash-Reservation & Seat Inventory Locking Engine

A backend built for one job: let **thousands of people hammer 200 seats at the same instant and
never sell a seat twice** - while staying fast, surviving crashes of every component, and keeping
an audit-grade record in PostgreSQL.

```
npm run reset && npm run loadtest && npm run verify
# -> exactly 200 BOOKED, everyone else 409 SOLD, Redis sold = Postgres = 200, PASS
```

Stack (as mandated): Node.js 18+ (CommonJS), Express, ioredis, pg, socket.io, dotenv; Redis 7 and
PostgreSQL 16 in Docker; undici for the load generator. No ORM, no queue broker, no nginx.

---

## 1. Architecture in plain language

```
                 round-robin (no LB on purpose)
  5000 users ───────────┬──────────────┬──────────────┐
                        ▼              ▼              ▼
                   api :3001      api :3002      api :3003        3 identical, stateless
                        │              │              │           Node processes
                        └──────────────┼──────────────┘
                                       ▼  Lua scripts (atomic)                 Pub/Sub "seat-events"
                               ┌──────────────────┐                             ──▶ Socket.IO clients
                               │     Redis 7      │  holds  (keys with TTL)
                               │ appendfsync      │  sold   (hash unit→bookingId)
                               │ always           │  pay:*  (payment sessions)
                               └────────┬─────────┘  bookings (Stream)
                                        │ XREADGROUP (consumer group "persisters")
                           ┌────────────┴────────────┐
                           ▼                         ▼
                     persist w1                persist w2        at-least-once, idempotent INSERT
                           └────────────┬────────────┘
                                        ▼
                               ┌──────────────────┐
                               │  PostgreSQL 16   │  bookings  UNIQUE(event_id, unit_id)
                               └──────────────────┘  dead_letters
                                        ▲
                     rehydrate (startup + every Redis reconnect): sold rows → Redis sold hash
                     reconciler (every 30 s): PAID sessions without a seat → REFUND
```

**The one idea everything hangs on:** every "look, then decide, then write" happens *inside Redis*,
in a Lua script, so it is a single indivisible step no matter how many API instances or requests
race each other. The API processes keep **no state** - kill any of them at any time.

### How a seat gets sold

1. **Hold** - `hold.lua`: *is it sold? is someone else holding it? no → write the hold key with a
   TTL*. The hold is a Redis key `evt:{e1}:hold:<unit>` = `userId`, `PX 90000`. Expiry is release;
   there is no sweeper and no server ever compares timestamps - **only Redis's clock decides**.
2. **Checkout** - a payment session `pay:<bookingId>` is created *only if* the caller still holds
   the seat.
3. **Pay** - a mock gateway (100 ms delay, configurable failure rate). An `HSETNX lock` guarantees a
   double click can never charge twice.
4. **Confirm** - `confirm.lua`: *not sold yet? caller still owns the hold? → delete the hold, write
   `sold[unit] = bookingId`, and `XADD` a note to the `bookings` stream*. All or nothing.
   Confirming the same bookingId twice returns OK (idempotent retries).
5. **Persist** - two worker processes read the stream through a consumer group and
   `INSERT ... ON CONFLICT (booking_id) DO NOTHING`. Only after the insert succeeds is the entry
   `XACK`ed + `XDEL`ed, so a worker crash can only cause a *re-delivery*, never a loss, and the
   idempotent insert makes re-delivery harmless. Entries stuck on a dead worker are taken over by
   the other via `XAUTOCLAIM` after 5 s.
6. **Final guard** - `UNIQUE (event_id, unit_id)` in Postgres. If every layer above failed and a
   second booking for the same seat ever reached the database, the worker would write it to
   `dead_letters` and shout. It never fires; `verify.js` checks that it never did.

### Who is the source of truth for what

| Question                              | Answered by | Why                                                       |
|---------------------------------------|-------------|-----------------------------------------------------------|
| Is this seat held *right now*?        | Redis       | TTL semantics, sub-millisecond, atomic with the decision  |
| Is this seat sold?                    | Postgres    | durable, relational, auditable; Redis mirrors it (`sold`)  |
| Redis lost its data / reconnected?    | rehydrate   | `SELECT unit_id, booking_id` → `HSETNX sold` at boot and on every Redis `ready` |
| Redis unreachable?                    | **503**     | fail closed - the engine never sells from Postgres          |

### Why zero double bookings is a guarantee, not luck

* A seat can only become *sold* through `confirm.lua`, which checks the sold hash and the hold
  ownership in the same atomic step that writes the sale. Two confirms for one seat cannot
  interleave; the second one sees `sold` and returns `SOLD`.
* A hold can only be taken through `hold.lua`, which refuses if the seat is sold or held by someone
  else - again atomically. Two users can never hold the same seat at the same time.
* The payment lock, the idempotent confirm and the idempotent insert make every retry safe.
* Postgres `UNIQUE(event_id, unit_id)` catches anything else, and `verify.js` would report it.

---

## 2. Prerequisites

* **Docker** (with the `docker compose` plugin) - runs Redis 7 and PostgreSQL 16.
* **Node.js 18+** - runs everything else on the host (3 APIs, 2 workers, 1 reconciler, the tests).

Nothing else. No global npm packages, no local Redis/Postgres installation.

## 3. Setup

```bash
cd backend
docker compose up -d        # Redis (appendonly, fsync always) + Postgres (runs db/schema.sql on first start)
npm install
cp .env.example .env        # Windows: copy .env.example .env   (optional - every value has a default)
```

`docker compose up -d` returns before Postgres has finished its first initialisation; every script
below waits for it, so you can chain the commands immediately.

## 4. Run

```bash
npm run start:all
```

`scripts/start-all.js` launches **api-3001, api-3002, api-3003, persist-w1, persist-w2,
reconciler** as plain `node` children, prefixes every log line with the process name, restarts a
child that dies (1 s, then exponential backoff up to 10 s for crash loops) and stops everything on
Ctrl+C. Works on Linux, macOS and Windows (no shell tricks, no POSIX-only signals).

Individual pieces, if you prefer separate terminals:

```bash
PORT=3001 npm run start:api        # one API instance
WORKER_ID=w1 npm run start:worker  # one persist worker
npm run start:reconciler
```

Quick smoke test:

```bash
curl -s localhost:3001/health
curl -s -X POST localhost:3001/book -H 'content-type: application/json' -H 'x-user-id: alice' -d '{"unit":7}'
curl -s localhost:3002/seats | head -c 200
```

## 5. Test (what the hackathon is judged on)

```bash
npm run reset        # 200 free seats, empty tables, empty stream, fresh consumer group
npm run loadtest     # 5000 concurrent users vs 200 seats across the 3 ports
npm run verify       # cross-checks Redis against Postgres and prints PASS / FAIL
```

Expected with the default `.env` (`PAYMENT_FAIL_RATE=0`):

```
Final outcome per user (one row per virtual user):
  outcome                        count
  ------------------------------------
  409 SOLD                        4800
  200 BOOKED                       200

All responses (including retries):
  409 SOLD                        9600
  409 HELD                         497
  200 BOOKED                       200

Latency (ms, all requests):
  p50=...  p95=...  p99=...  max=...
Throughput:
  10297 requests in 5.14 s  ->  2005.0 req/s
 RESULT: OK - 200 BOOKED <= 200 seats
```

```
  Redis sold count (HLEN evt:{e1}:sold) : 200
  Postgres bookings count                : 200
  Duplicate seats in Postgres            : 0
  dead_letters rows                      : 0
  Redis<->Postgres row mismatches        : 0
 PASS - zero double bookings, Redis and Postgres consistent
```

`race.js` exits 1 if `BOOKED > SEATS` (a double booking); `verify.js` exits 1 unless
`redisSold == pgCount && duplicates == 0 && deadLetters == 0 && pgCount <= TOTAL_UNITS` (and, as an
extra check, every `(unit, bookingId)` pair matches between Redis and Postgres).

Knobs: `USERS=10000 SEATS=200 npm run loadtest`, `PORTS=3001,3002 npm run loadtest`,
`CONNECTIONS=200` (per port). Latency numbers include client-side queueing in the three
100-connection pools, so they scale with the CPU cores you give the six Node processes.

### The 10 % payment-failure scenario

```bash
# in .env:  PAYMENT_FAIL_RATE=0.1   (then restart start-all)
npm run reset && npm run loadtest && npm run verify
```

About 20 payments fail (`402 PAYMENT_FAILED`); each failure releases the hold immediately
(`release.lua`), the seat is re-bookable at once and another user takes it, so the end result is
still `200 BOOKED`, `Redis = Postgres = 200`, PASS.

### Failure drills

See [`loadtest/chaos.md`](loadtest/chaos.md): kill a worker, stop Postgres, restart Redis,
abandon a hold, kill an API - with the exact commands and the log lines you should see.

---

## 6. API contract

All bodies are JSON. Every `POST` requires the header `x-user-id: <string>` (the user identity for
this hackathon - there is no login). Rate limit: a token bucket per user (20 burst, 10/s refill)
evaluated inside Redis.

| Method & path     | Body                     | Success                                                        | Other outcomes                                                                                              |
|-------------------|--------------------------|----------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------|
| `GET /health`     | -                        | `200 {redis:"ok", postgres:"ok", ready:true, port}`            | `503` with the same body when either dependency is down or `ready:false` (`redis:"not_ready"` before rehydration finishes) |
| `GET /seats`      | -                        | `200 {event, total, seats:[{unit, state}], counts:{free, held, sold}}` | `503` if Redis is down                                                                              |
| `POST /hold`      | `{unit}`                 | `200 {ok:true, unit, expiresInMs}`                              | `409 {ok:false, reason:"HELD"}` someone else holds it · `409 {reason:"SOLD"}` · `503 {ok:false, reason:"NOT_READY"}` (`Retry-After: 1`) |
| `POST /release`   | `{unit}`                 | `200 {released:true}`                                           | `200 {released:false}` (not your hold / already gone)                                                        |
| `POST /checkout`  | `{unit, bookingId}`      | `200 {ok:true, status:"PENDING", bookingId, unit}`              | `409 {reason:"NO_HOLD"}` you do not hold the seat · `409 {reason:"BOOKING_ID_CONFLICT"}` id used by another booking |
| `POST /pay`       | `{bookingId}`            | `200 {ok:true, status:"BOOKED", bookingId, unit}`               | `402 PAYMENT_FAILED` (hold released) · `409 SOLD` (paid → refunded) · `410 EXPIRED` (hold expired → refunded) · `202 PAYMENT_IN_PROGRESS` (duplicate click while charging) · `404 NO_SESSION` · `403 FORBIDDEN` (not your session) |
| `POST /book`      | `{unit, bookingId?}`     | `200 {ok:true, status:"BOOKED", bookingId, unit}`               | hold + checkout + pay + confirm in one call: `409 HELD` · `409 SOLD` · `402 PAYMENT_FAILED` · `410 EXPIRED` · `429` · `503` (`NOT_READY` with `Retry-After: 1` or `SERVICE_UNAVAILABLE`) |

Cross-cutting: `401 {error:"UNAUTHENTICATED"}` missing `x-user-id` · `400` invalid `unit`
(must be an integer 1..`TOTAL_UNITS`), invalid `bookingId` (must be a UUID) or malformed JSON ·
`429 {error:"RATE_LIMITED"}` · `503 {error:"SERVICE_UNAVAILABLE"}` whenever Redis is unreachable.

`bookingId` is client-generated (UUID) so that `/checkout`, `/pay` and `/book` are safely retryable:
repeating `/checkout` returns the existing session, repeating `/pay` or `/book` (with the same
stable `bookingId`) never charges twice and re-confirming an already confirmed booking returns
`200 BOOKED` again (retrying `/book` with another user's `bookingId` returns `409 BOOKING_ID_CONFLICT`).
Clients must send a stable `bookingId` to make `/book` retry-safe.

### Live updates (Socket.IO)

Connect a Socket.IO client to any instance. On connect it receives `seatmap`
(`{event, total, seats}`), then a `seat` event (`{unit, state: "held" | "free" | "sold"}`) for every
change made on **any** instance - the instances relay Redis Pub/Sub channel `seat-events`. This path
is best-effort and can never fail a booking.

---

## 7. Crashes and recovery

| What dies                               | What users see                                                                              | How it recovers                                                                                                                                 |
|-----------------------------------------|---------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| **One API instance**                    | In-flight requests on that port fail; the other two ports are unaffected                    | start-all restarts it in 1 s; it rehydrates and listens again. A confirm that already ran stays valid - retrying `/pay` returns `BOOKED`.         |
| **A persist worker**                    | Nothing                                                                                     | Its unacked entries sit in the consumer group's pending list; the other worker reclaims them with `XAUTOCLAIM` after 5 s; start-all restarts it. |
| **Postgres** (seconds or minutes)       | Nothing - booking only needs Redis. `/health` reports `postgres:"down"` (503)               | Workers log once and wait; the stream buffers every booking; when Postgres is back they drain it in seconds. `verify` converges.                 |
| **Redis** (restart)                     | `503 SERVICE_UNAVAILABLE` within milliseconds until it is back (**fail closed**)            | ioredis reconnects (200 ms → 2 s backoff); every `ready` event triggers `rehydrate()`; the AOF (`appendfsync always`) means nothing was lost anyway. |
| **Redis with data loss**                | `503 {reason:"NOT_READY"}` (`Retry-After: 1`) until rehydration completes                   | `hold.lua` gates on `evt:{e1}:ready`, which `rehydrate()` sets only after restoring all Postgres-persisted sales into `sold` (retrying with exponential backoff on reconnect). Note: confirmed sales still in the Redis stream and not yet persisted to Postgres are lost on a full Redis wipe; use AOF (`appendfsync everysec` or `always`) + a replica + `WAIT` to protect in-flight stream entries. |
| **API dies between "PAID" and confirm** | The user got no answer                                                                      | The reconciler sweeps `pay:*` every 30 s and marks `PAID` sessions older than 30 s whose seat is not sold to them as `REFUND`.                   |
| **Hold abandoned**                      | Seat shows `held` until the TTL runs out                                                    | Redis expires the key; the seat is `free` again. No code involved.                                                                             |

Rules that make this work: XACK only after a successful INSERT (at-least-once), idempotent INSERT,
idempotent confirm, no in-memory state anywhere, `SCAN` instead of `KEYS` everywhere, and a process
never crashes because one request failed (async errors are routed to the error handler;
`unhandledRejection` is logged, not fatal).

Known limitations (hackathon scope, all documented in code): a request that dies *during* the
mock charge leaves the session `PENDING` with the payment lock held until the session TTL expires -
a real gateway integration would query the charge status instead; the reconciler's 30 s grace
window versus a very late `/pay` retry is not transactional across the two keys (a ledger such as
TigerBeetle would make the refund/confirm pair atomic).

---

## 8. Configuration

`.env` (see `.env.example`; every value has the default shown). `scripts/start-all.js` overrides
`PORT` and `WORKER_ID` per child.

| Variable                | Default                                          | Meaning                                                             |
|-------------------------|--------------------------------------------------|---------------------------------------------------------------------|
| `PORT`                  | `3001`                                           | HTTP port of one API instance                                       |
| `REDIS_URL`             | `redis://127.0.0.1:6379`                         |                                                                     |
| `DATABASE_URL`          | `postgres://postgres:pass@localhost:5432/tickets`|                                                                     |
| `EVENT_ID`              | `e1`                                             | the single event being sold (Redis hash-tag `{e1}`)                 |
| `TOTAL_UNITS`           | `200`                                            | seats 1..N                                                          |
| `HOLD_TTL_MS`           | `90000`                                          | hold lifetime - enforced by Redis key expiry only                   |
| `PAY_SESSION_TTL_MS`    | `90000`                                          | lifetime of PENDING / FAILED payment sessions                       |
| `PAID_SESSION_TTL_MS`   | `3600000`                                        | how long PAID sessions stay visible to the reconciler               |
| `PAYMENT_DELAY_MS`      | `100`                                            | mock gateway latency                                                |
| `PAYMENT_FAIL_RATE`     | `0`                                              | 0..1 probability a mock payment fails                               |
| `RATE_LIMIT_ENABLED`    | `true`                                           |                                                                     |
| `BUCKET_CAPACITY`       | `20`                                             | per-user burst                                                      |
| `BUCKET_REFILL_PER_SEC` | `10`                                             | per-user sustained rate                                             |
| `WORKER_ID`             | `w1`                                             | consumer name in group `persisters`                                 |
| `API_PORTS`             | `3001,3002,3003`                                 | (start-all only) which API instances to launch                      |

### If 6379 or 5432 are already in use on your machine

Change the **host** side of the port mapping in `docker-compose.yml` and point the URLs at it:

```yaml
    ports: ["16379:6379"]      # redis
    ports: ["15432:5432"]      # postgres
```

```dotenv
REDIS_URL=redis://127.0.0.1:16379
DATABASE_URL=postgres://postgres:pass@localhost:15432/tickets
```

Then `docker compose up -d` again. Nothing else changes - every process and script reads the URLs
from `.env`. If 3001-3003 clash, set `API_PORTS=4001,4002,4003` for start-all and
`PORTS=4001,4002,4003` for the load test.

### Load-testing beyond the defaults

The three instances accept up to 20 000 connections each (`server.maxConnections`), listen with a
4096 backlog and keep connections alive for 65 s. If you point a harness with *thousands of real
sockets* (rather than pooled connections) at them, raise the per-process file-descriptor limit first
(`ulimit -n 65536` on Linux/macOS - the default is 1024/256). On Linux also consider
`sysctl -w net.core.somaxconn=4096`.

---

## 9. Project layout

```
backend/
  docker-compose.yml          Redis 7 (AOF, fsync always) + Postgres 16 (+ schema on first start)
  db/schema.sql               bookings (UNIQUE event_id, unit_id) + dead_letters
  src/
    config.js                 .env parsing, frozen config, Redis key builders
    redis.js                  ioredis clients, Lua registration (defineCommand), fail-closed options
    pg.js                     pg.Pool (max 10) + waitForPostgres
    lua/hold.lua              atomic hold            (commented line by line)
    lua/confirm.lua           atomic hold -> sold + stream note
    lua/release.lua           atomic owner-checked release
    lua/bucket.lua            token bucket on Redis's clock
    services/inventory.js     holdSeat / releaseSeat / confirmSeat / getSeatMap + Pub/Sub
    services/payment.js       mock gateway: createSession / pay (HSETNX lock) / settle
    middleware/               identify (x-user-id), validate, rateLimit, errorHandler (+asyncHandler)
    routes/                   health, seats, reserve (/hold /release), pay (/checkout /pay), book (/book)
    app.js                    Express app (no listen)
    socket.js                 Socket.IO + dedicated Redis subscriber
    rehydrate.js              Postgres sold rows -> Redis sold hash (HSETNX, idempotent)
    server.js                 startup order, keep-alive tuning, graceful shutdown
  worker/persist.js           stream consumer: XAUTOCLAIM + XREADGROUP -> INSERT -> XACK/XDEL
  worker/reconciler.js        SCAN pay:* every 30 s, refund PAID-without-seat
  scripts/start-all.js        cross-platform supervisor for the 6 processes
  scripts/reset.js            wipe event keys / sessions / buckets / stream, truncate tables
  loadtest/race.js            5000 users vs 200 seats through undici pools
  loadtest/verify.js          Redis vs Postgres consistency check (PASS / FAIL)
  loadtest/chaos.md           manual failure drills
```

Rules enforced by the structure: **no route imports `pg`** except `/health`; Postgres is touched
only by `rehydrate.js`, `worker/*`, `scripts/*`, `loadtest/verify.js` and `routes/health.js`.

---

## 10. Production upgrades (what we would do next)

* **Durability beyond one Redis box - replica + `WAIT`.** Add a Redis replica and have
  `confirmSeat` follow the Lua call with `WAIT 1 <timeout>` so a sale is acknowledged only once it
  is on two machines; pair it with Sentinel or a managed failover. `appendfsync always` already
  protects against process crashes, `WAIT` protects against losing the host.
* **A real money ledger - TigerBeetle.** Replace the mock `pay:*` hash with two-phase transfers in
  TigerBeetle (pending transfer on hold, post on confirm, void on release/expiry). The ledger
  becomes the source of truth for "who paid for what", refunds are a `void`, and the reconciler
  turns into a straightforward comparison of pending transfers against the sold hash.
* **A virtual waiting room.** Put a queue in front of `/hold` (a Redis sorted set of arrivals or a
  CDN waiting room) that admits users in batches sized to the available inventory. Fairness
  improves, the 429s disappear, and the hot path only ever sees as many users as there are seats
  to fight over.
* **Horizontal Redis - Redis Cluster.** All keys of an event already share the hash-tag `{e1}`, so
  `hold.lua` / `confirm.lua` touch a single slot and keep working on a cluster; each event lands on
  its own shard, which is exactly the partitioning a multi-event platform wants. (Rename the stream
  to `evt:{e1}:bookings` so `confirm.lua` stays single-slot there.)
* Smaller items: real authentication behind `x-user-id`, an ingress/load balancer with health-aware
  failover in front of the instances, structured logs + metrics (hold/confirm rates, stream lag,
  reconciler refunds), and per-seat-section inventory instead of a single flat range.

---

## 11. Troubleshooting

* `npm run loadtest` says *NOT HEALTHY* → start the stack (`npm run start:all`) and wait for the
  three `listening on` lines. Postgres down is only a warning there.
* `[pg] not reachable ... retrying` right after `docker compose up -d` → normal for 5-15 s on the
  very first start while Postgres initialises; everything waits automatically.
* `npm run reset` while the stack is running is fine: the workers notice the recreated consumer
  group (`NOGROUP`) and continue.
* Changed `db/schema.sql`? The container only runs it on an empty volume - `npm run reset` applies it
  too (it is idempotent), or `docker compose down -v` for a clean slate.
* Windows: use PowerShell; `cp` → `copy`, `kill` → `taskkill /PID <pid> /F`; environment variables
  inline as `$env:PAYMENT_FAIL_RATE=0.1; npm run start:all`.
