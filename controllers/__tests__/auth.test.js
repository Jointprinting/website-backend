// controllers/__tests__/auth.test.js
//
// The studio auth path — single-user login (controllers/auth.js) + the Bearer-token
// gate (middleware/auth.js). No DB: studioLogin's only DB touch is AdminUser.findOne,
// which we mock, and requireAdmin is pure jwt.verify. These pin the behavior the
// whole Studio — and, later, multi-user agent accounts — sits on:
//   • correct password → a signed token whose sub/scope/TTL are what we expect
//   • wrong / missing password → rejected (401 / 400), failed-attempt counter rises
//   • repeated failures → lockout (429 while locked)
//   • only a valid, unexpired, correctly-signed Bearer token opens an admin route
//
//   node --test controllers/__tests__/auth.test.js

// Must be set BEFORE requiring the modules under test — both read JWT_SECRET (and
// the login TTL) at module-load time. Force the default TTL so we can assert it.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-abc123';
delete process.env.STUDIO_TOKEN_TTL;

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const AdminUser = require('../../models/AdminUser');
const authController = require('../auth');
const { requireAdmin } = require('../../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET;
const PASSWORD = 'correct-horse-battery-staple';
const HASH = bcrypt.hashSync(PASSWORD, 10);

// Minimal Express res double: captures status + json body, chainable like the real one.
function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// A fresh fake AdminUser row (with a working save()) for each login test, so state
// mutated by the controller (attempts, lockout) is observable without a database.
function fakeUser(overrides = {}) {
  return {
    username: 'studio',
    passwordHash: HASH,
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastLoginAt: null,
    saved: 0,
    async save() { this.saved += 1; },
    ...overrides,
  };
}

// ── studioLogin ───────────────────────────────────────────────────────────────

test('studioLogin: missing / non-string password → 400 (no DB lookup needed)', async (t) => {
  t.mock.method(AdminUser, 'findOne', async () => fakeUser());

  const res1 = mockRes();
  await authController.studioLogin({ body: {} }, res1);
  assert.equal(res1.statusCode, 400);

  const res2 = mockRes();
  await authController.studioLogin({ body: { password: 12345 } }, res2);
  assert.equal(res2.statusCode, 400);
});

test('studioLogin: no admin user configured → 401 with setup hint', async (t) => {
  t.mock.method(AdminUser, 'findOne', async () => null);
  const res = mockRes();
  await authController.studioLogin({ body: { password: PASSWORD } }, res);
  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /isn't set up|set-studio-password/i);
});

test('studioLogin: wrong password → 401 and the failed-attempt counter rises', async (t) => {
  const user = fakeUser();
  t.mock.method(AdminUser, 'findOne', async () => user);
  const res = mockRes();
  await authController.studioLogin({ body: { password: 'wrong' } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(user.failedLoginAttempts, 1);
  assert.ok(user.saved >= 1, 'the incremented counter is persisted');
});

test('studioLogin: correct password → signed token, default 7d TTL, counters reset', async (t) => {
  const user = fakeUser({ failedLoginAttempts: 3 });
  t.mock.method(AdminUser, 'findOne', async () => user);
  const res = mockRes();
  await authController.studioLogin({ body: { password: PASSWORD } }, res);

  // Success path calls res.json() without res.status() → our mock stays at null.
  assert.equal(res.statusCode, null);
  assert.ok(res.body.token, 'a token is returned');
  assert.equal(res.body.expiresIn, '7d', 'TTL default is the hardened 7 days');

  const decoded = jwt.verify(res.body.token, JWT_SECRET);
  assert.equal(decoded.sub, 'studio');
  assert.equal(decoded.scope, 'studio');
  assert.equal(decoded.exp - decoded.iat, 7 * 24 * 60 * 60, 'token really expires in 7 days');

  assert.equal(user.failedLoginAttempts, 0, 'attempts reset on success');
  assert.equal(user.lockedUntil, null, 'lockout cleared on success');
  assert.ok(user.lastLoginAt instanceof Date, 'lastLoginAt stamped');
});

test('studioLogin: the 5th consecutive failure locks the account', async (t) => {
  const user = fakeUser({ failedLoginAttempts: 4 }); // one more failure trips the lock
  t.mock.method(AdminUser, 'findOne', async () => user);
  const res = mockRes();
  await authController.studioLogin({ body: { password: 'wrong' } }, res);

  assert.equal(res.statusCode, 401);
  assert.ok(user.lockedUntil instanceof Date, 'lockout timestamp set');
  assert.ok(user.lockedUntil.getTime() > Date.now(), 'lockout is in the future');
  assert.equal(user.failedLoginAttempts, 0, 'counter resets once locked');
});

test('studioLogin: a locked account is refused with 429 even with the right password', async (t) => {
  const user = fakeUser({ lockedUntil: new Date(Date.now() + 10 * 60 * 1000) });
  t.mock.method(AdminUser, 'findOne', async () => user);
  const res = mockRes();
  await authController.studioLogin({ body: { password: PASSWORD } }, res);
  assert.equal(res.statusCode, 429);
});

// ── requireAdmin (the Bearer-token gate) ────────────────────────────────────────

test('requireAdmin: missing Authorization header → 401, next() not called', () => {
  const res = mockRes();
  let nextCalled = 0;
  requireAdmin({ headers: {} }, res, () => { nextCalled += 1; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, 0);
});

test('requireAdmin: malformed header (not "Bearer <token>") → 401', () => {
  const res = mockRes();
  let nextCalled = 0;
  requireAdmin({ headers: { authorization: 'Token abc.def' } }, res, () => { nextCalled += 1; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, 0);
});

test('requireAdmin: token signed with the wrong secret → 401', () => {
  const forged = jwt.sign({ sub: 'studio', scope: 'studio' }, 'not-the-real-secret');
  const res = mockRes();
  let nextCalled = 0;
  requireAdmin({ headers: { authorization: `Bearer ${forged}` } }, res, () => { nextCalled += 1; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, 0);
});

test('requireAdmin: expired token → 401', () => {
  const expired = jwt.sign({ sub: 'studio', scope: 'studio' }, JWT_SECRET, { expiresIn: -10 });
  const res = mockRes();
  let nextCalled = 0;
  requireAdmin({ headers: { authorization: `Bearer ${expired}` } }, res, () => { nextCalled += 1; });
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, 0);
});

test('requireAdmin: a valid token → next() runs and req.adminUser is populated', () => {
  const good = jwt.sign({ sub: 'studio', scope: 'studio' }, JWT_SECRET, { expiresIn: '7d' });
  const req = { headers: { authorization: `Bearer ${good}` } };
  const res = mockRes();
  let nextCalled = 0;
  requireAdmin(req, res, () => { nextCalled += 1; });
  assert.equal(nextCalled, 1);
  assert.equal(res.statusCode, null, 'no error response written');
  assert.equal(req.adminUser.username, 'studio');
  assert.equal(req.adminUser.scope, 'studio');
});

// ── Full loop: login → use the token on an admin route ──────────────────────────

test('a token minted by studioLogin is accepted by requireAdmin', async (t) => {
  const user = fakeUser();
  t.mock.method(AdminUser, 'findOne', async () => user);

  const loginRes = mockRes();
  await authController.studioLogin({ body: { password: PASSWORD } }, loginRes);
  const token = loginRes.body.token;

  const req = { headers: { authorization: `Bearer ${token}` } };
  let nextCalled = 0;
  requireAdmin(req, mockRes(), () => { nextCalled += 1; });
  assert.equal(nextCalled, 1);
  assert.equal(req.adminUser.username, 'studio');
});
