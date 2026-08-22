// controllers/__tests__/clientErrors.test.js
//   node --test controllers/__tests__/clientErrors.test.js
//
// A crash in a client's browser used to be a console.error in a tab nobody was
// looking at. On /approve that fallback is being read by someone trying to
// approve an order, and the owner found out only if they phoned in.
//
// Two things about this endpoint make its pure helpers worth pinning hard:
//
//   1. It is PUBLIC — it has to be, because the crash may have taken down the
//      app that would have carried a token. So the route stored must never be
//      the URL: the token in /approve/<token> IS the client's credential, and
//      writing it into an error log hands it to anyone who can read the log.
//   2. It aggregates by fingerprint. Get that wrong in one direction and forty
//      people hitting one bug read as forty bugs; wrong in the other and two
//      unrelated crashes merge into one row nobody can diagnose.

const test = require('node:test');
const assert = require('node:assert/strict');

const { routePattern, fingerprintOf, browserFamily } = require('../clientErrors');

// ── routePattern: the credential must not survive ───────────────────────────

test('an approval token never reaches storage', () => {
  assert.equal(routePattern('/approve/9f8e7d6c5b4a39281706f5e4d3c2b1a0'), '/approve/:token');
});

test('every token-authenticated client route is reduced to its pattern', () => {
  const tok = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  assert.equal(routePattern(`/lookbook/${tok}`), '/lookbook/:token');
  assert.equal(routePattern(`/portal/${tok}`), '/portal/:token');
  assert.equal(routePattern(`/preorder/${tok}`), '/preorder/:token');
});

test('a long opaque segment is redacted even when it is not hex', () => {
  assert.equal(routePattern('/portal/ZmFrZS10b2tlbi12YWx1ZS1oZXJl'), '/portal/:token');
});

test('an ObjectId reads as :id, which is more useful than :token when triaging', () => {
  assert.equal(routePattern('/order/68a1b2c3d4e5f60718293a4b'), '/order/:id');
});

test('a plain numeric segment is a number, not a secret', () => {
  assert.equal(routePattern('/project/1042'), '/project/:n');
});

test('the query string and hash are dropped — they carry tokens too', () => {
  assert.equal(routePattern('/studio?tab=crm&token=abc'), '/studio');
  assert.equal(routePattern('/studio#deep'), '/studio');
});

test('ordinary paths survive intact, or there is nothing to triage by', () => {
  assert.equal(routePattern('/studio'), '/studio');
  assert.equal(routePattern('/products/tees'), '/products/tees');
  assert.equal(routePattern('/'), '/');
});

test('junk paths never throw and never produce something odd', () => {
  for (const junk of [null, undefined, '', 'not-a-path', 42, {}]) {
    assert.doesNotThrow(() => routePattern(junk));
    assert.ok(routePattern(junk).startsWith('/'));
  }
});

test('an absurdly long path is capped', () => {
  assert.ok(routePattern(`/${'a'.repeat(500)}`).length <= 120);
});

// ── fingerprintOf: one bug, one row ─────────────────────────────────────────

test('the same crash from two people lands on ONE row', () => {
  const stack = 'Error: boom\n    at Widget (/static/js/main.chunk.js:2:100)';
  assert.equal(fingerprintOf('boom', stack), fingerprintOf('boom', stack));
});

test('the same crash across two BUILDS is still one row', () => {
  // Otherwise every deploy resets the count and a persistent bug looks new.
  const a = 'at Widget (https://jointprinting.com/static/js/main.abc12345.chunk.js:2:100)';
  const b = 'at Widget (https://preview-x.vercel.app/static/js/main.99999999.chunk.js:2:100)';
  assert.equal(fingerprintOf('boom', a), fingerprintOf('boom', b));
});

test('two DIFFERENT crashes with the same message stay apart', () => {
  // "undefined is not a function" from two places is two bugs.
  const a = 'at Quote (/static/js/main.chunk.js:2:100)';
  const b = 'at Approval (/static/js/main.chunk.js:9:400)';
  assert.notEqual(fingerprintOf('undefined is not a function', a),
    fingerprintOf('undefined is not a function', b));
});

test('the same frame with two different messages stays apart', () => {
  const s = 'at Widget (/static/js/main.chunk.js:2:100)';
  assert.notEqual(fingerprintOf('cannot read x', s), fingerprintOf('cannot read y', s));
});

test('only the FIRST frame counts — a deeper stack does not fork the row', () => {
  const top = 'at Widget (/static/js/main.chunk.js:2:100)';
  const a = `Error\n    ${top}\n    at A (/x.js:1:1)`;
  const b = `Error\n    ${top}\n    at B (/y.js:9:9)`;
  assert.equal(fingerprintOf('boom', a), fingerprintOf('boom', b));
});

test('a crash with no stack still fingerprints on its message', () => {
  assert.equal(fingerprintOf('boom', ''), fingerprintOf('boom', undefined));
  assert.notEqual(fingerprintOf('boom', ''), fingerprintOf('bang', ''));
});

test('fingerprints are always a fixed-length hex digest', () => {
  for (const [m, s] of [['a', 'b'], ['', ''], [null, null], ['x'.repeat(9999), 'y'.repeat(9999)]]) {
    assert.match(fingerprintOf(m, s), /^[0-9a-f]{40}$/);
  }
});

// ── browserFamily: coarse on purpose ────────────────────────────────────────

test('the major families are told apart', () => {
  assert.equal(browserFamily('Mozilla/5.0 Chrome/120 Safari/537.36'), 'Chrome');
  assert.equal(browserFamily('Mozilla/5.0 (iPhone) AppleWebKit Safari/604.1'), 'Safari');
  assert.equal(browserFamily('Mozilla/5.0 Firefox/121.0'), 'Firefox');
});

test('Chrome-derived browsers are not all reported as Chrome', () => {
  // Both send "Chrome/..." in their UA, so order matters.
  assert.equal(browserFamily('Mozilla/5.0 Chrome/120 Safari/537.36 Edg/120'), 'Edge');
  assert.equal(browserFamily('Mozilla/5.0 Chrome/120 Safari/537.36 OPR/106'), 'Opera');
});

test('an unknown or missing agent is Other, never a crash', () => {
  assert.equal(browserFamily(''), 'Other');
  assert.equal(browserFamily(null), 'Other');
  assert.equal(browserFamily('curl/8.0'), 'Other');
});
