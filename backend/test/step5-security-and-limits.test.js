'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const path = require('path');
const { cleanRedis, startTestServer } = require('./helpers');

function createJwt(payload, secret, header = { alg: 'HS256', typ: 'JWT' }) {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

describe('Step 5 (Finding 5): Per-user hold cap, max hold duration, JWT auth, and IP rate limit', () => {
  let srv;

  before(async () => {
    srv = await startTestServer();
  });

  beforeEach(async () => {
    delete process.env.AUTH_MODE;
    delete process.env.JWT_SECRET;
    delete process.env.MAX_HOLDS_PER_USER;
    delete process.env.HOLD_TTL_MS;
    delete process.env.MAX_HOLD_TOTAL_MS;
    delete process.env.IP_BUCKET_CAPACITY;
    delete process.env.IP_BUCKET_REFILL_PER_SEC;
    await cleanRedis();
  });

  after(async () => {
    delete process.env.AUTH_MODE;
    delete process.env.JWT_SECRET;
    delete process.env.MAX_HOLDS_PER_USER;
    delete process.env.HOLD_TTL_MS;
    delete process.env.MAX_HOLD_TOTAL_MS;
    delete process.env.IP_BUCKET_CAPACITY;
    delete process.env.IP_BUCKET_REFILL_PER_SEC;
    if (srv) await srv.close();
  });

  it('enforces MAX_HOLDS_PER_USER (429 HOLD_LIMIT) and does not double-count refreshes of an existing own hold', async () => {
    process.env.MAX_HOLDS_PER_USER = '3';

    for (const unit of [1, 2, 3]) {
      const res = await srv.request('POST', '/hold', {
        headers: { 'x-user-id': 'hoarder' },
        body: { unit },
      });
      assert.equal(res.status, 200, `hold on unit ${unit} should succeed`);
    }

    // Refreshing an already-held seat (unit 2) must succeed and not count twice
    const refreshRes = await srv.request('POST', '/hold', {
      headers: { 'x-user-id': 'hoarder' },
      body: { unit: 2 },
    });
    assert.equal(refreshRes.status, 200);

    // Attempting to hold a 4th seat must fail with 429 HOLD_LIMIT
    const fourthRes = await srv.request('POST', '/hold', {
      headers: { 'x-user-id': 'hoarder' },
      body: { unit: 4 },
    });
    assert.equal(fourthRes.status, 429);
    assert.equal(fourthRes.json.reason, 'HOLD_LIMIT');
  });

  it('released, confirmed, and expired holds free the user quota', async () => {
    process.env.MAX_HOLDS_PER_USER = '2';
    process.env.HOLD_TTL_MS = '120';
    process.env.MAX_HOLD_TOTAL_MS = '1000';

    // Hold 2 seats (reaches cap of 2)
    assert.equal((await srv.request('POST', '/hold', { headers: { 'x-user-id': 'alice' }, body: { unit: 10 } })).status, 200);
    assert.equal((await srv.request('POST', '/hold', { headers: { 'x-user-id': 'alice' }, body: { unit: 11 } })).status, 200);
    assert.equal((await srv.request('POST', '/hold', { headers: { 'x-user-id': 'alice' }, body: { unit: 12 } })).status, 429);

    // 1. Release unit 10 -> frees 1 slot -> can now hold unit 12
    const rel = await srv.request('POST', '/release', { headers: { 'x-user-id': 'alice' }, body: { unit: 10 } });
    assert.equal(rel.status, 200);
    assert.equal(rel.json.released, true);
    assert.equal((await srv.request('POST', '/hold', { headers: { 'x-user-id': 'alice' }, body: { unit: 12 } })).status, 200);

    // 2. Confirm unit 11 (checkout + pay) -> frees 1 slot -> can now hold unit 13
    const bookingId = crypto.randomUUID();
    assert.equal((await srv.request('POST', '/checkout', { headers: { 'x-user-id': 'alice' }, body: { unit: 11, bookingId } })).status, 200);
    assert.equal((await srv.request('POST', '/pay', { headers: { 'x-user-id': 'alice' }, body: { bookingId } })).status, 200);
    assert.equal((await srv.request('POST', '/hold', { headers: { 'x-user-id': 'alice' }, body: { unit: 13 } })).status, 200);

    // 3. Wait for holds on 12 & 13 to expire (120ms) -> frees quota -> can hold units 14 & 15
    await new Promise((r) => setTimeout(r, 160));
    assert.equal((await srv.request('POST', '/hold', { headers: { 'x-user-id': 'alice' }, body: { unit: 14 } })).status, 200);
    assert.equal((await srv.request('POST', '/hold', { headers: { 'x-user-id': 'alice' }, body: { unit: 15 } })).status, 200);
  });

  it('refreshing a hold cannot extend the lock beyond MAX_HOLD_TOTAL_MS', async () => {
    process.env.HOLD_TTL_MS = '120';
    process.env.MAX_HOLD_TOTAL_MS = '220';

    // Alice holds unit 25 at t=0
    const h1 = await srv.request('POST', '/hold', { headers: { 'x-user-id': 'alice' }, body: { unit: 25 } });
    assert.equal(h1.status, 200);

    // Refresh at t=80ms and t=160ms
    await new Promise((r) => setTimeout(r, 80));
    const h2 = await srv.request('POST', '/hold', { headers: { 'x-user-id': 'alice' }, body: { unit: 25 } });
    assert.equal(h2.status, 200);

    await new Promise((r) => setTimeout(r, 80));
    const h3 = await srv.request('POST', '/hold', { headers: { 'x-user-id': 'alice' }, body: { unit: 25 } });
    assert.equal(h3.status, 200);

    // Wait another 90ms (t=250ms > MAX_HOLD_TOTAL_MS=220ms, even though only 90ms < HOLD_TTL_MS=120ms since last refresh)
    await new Promise((r) => setTimeout(r, 90));

    // Bob must now be able to hold unit 25 because Alice's lock was capped by MAX_HOLD_TOTAL_MS
    const bobHold = await srv.request('POST', '/hold', { headers: { 'x-user-id': 'bob' }, body: { unit: 25 } });
    assert.equal(bobHold.status, 200);
  });

  it('rejects forged x-user-id in jwt AUTH_MODE, verifies HS256 JWT + exp, and fails startup without JWT_SECRET', async () => {
    // 1. Fail startup if AUTH_MODE=jwt and JWT_SECRET is empty
    const bootRes = spawnSync(
      process.execPath,
      ['-e', "require('./src/config')"],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, AUTH_MODE: 'jwt', JWT_SECRET: '' },
        encoding: 'utf8',
      },
    );
    assert.notEqual(bootRes.status, 0, 'startup must fail when AUTH_MODE=jwt and JWT_SECRET is unset');

    // 2. Runtime JWT verification
    process.env.AUTH_MODE = 'jwt';
    process.env.JWT_SECRET = 'super-secret-key';

    // Forged x-user-id without JWT -> 401
    const forged = await srv.request('POST', '/hold', {
      headers: { 'x-user-id': 'admin' },
      body: { unit: 50 },
    });
    assert.equal(forged.status, 401);

    // Invalid signature -> 401
    const badToken = createJwt({ sub: 'alice', exp: Math.floor(Date.now() / 1000) + 60 }, 'wrong-secret');
    const badRes = await srv.request('POST', '/hold', {
      headers: { authorization: `Bearer ${badToken}`, 'x-user-id': 'forged' },
      body: { unit: 50 },
    });
    assert.equal(badRes.status, 401);

    // Expired token -> 401
    const expToken = createJwt({ sub: 'alice', exp: Math.floor(Date.now() / 1000) - 10 }, 'super-secret-key');
    const expRes = await srv.request('POST', '/hold', {
      headers: { authorization: `Bearer ${expToken}` },
      body: { unit: 50 },
    });
    assert.equal(expRes.status, 401);

    // Valid token -> uses sub ('real-alice') and ignores forged x-user-id ('forged-bob')
    const validToken = createJwt({ sub: 'real-alice', exp: Math.floor(Date.now() / 1000) + 60 }, 'super-secret-key');
    const okRes = await srv.request('POST', '/hold', {
      headers: { authorization: `Bearer ${validToken}`, 'x-user-id': 'forged-bob' },
      body: { unit: 50 },
    });
    assert.equal(okRes.status, 200);

    // Verify hold belongs to 'real-alice', not 'forged-bob'
    const bookingId = crypto.randomUUID();
    const coForged = await srv.request('POST', '/checkout', {
      headers: {
        authorization: `Bearer ${createJwt({ sub: 'forged-bob', exp: Math.floor(Date.now() / 1000) + 60 }, 'super-secret-key')}`,
      },
      body: { unit: 50, bookingId },
    });
    assert.equal(coForged.status, 409);
    assert.equal(coForged.json.reason, 'NO_HOLD');
  });

  it('IP rate-limit bucket throttles requests across many forged x-user-id values from one IP', async () => {
    process.env.IP_BUCKET_CAPACITY = '5';
    process.env.IP_BUCKET_REFILL_PER_SEC = '0.1';

    const statuses = [];
    for (let i = 1; i <= 7; i++) {
      const res = await srv.request('POST', '/hold', {
        headers: { 'x-user-id': `sybil-user-${i}` },
        body: { unit: i },
      });
      statuses.push(res.status);
    }

    assert.deepEqual(statuses.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.equal(statuses[5], 429);
    assert.equal(statuses[6], 429);
  });
});
