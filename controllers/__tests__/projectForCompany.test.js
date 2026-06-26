// controllers/__tests__/projectForCompany.test.js
//
// Pure-logic checks for the LEAD -> QUOTE handoff idempotency core: given a
// company's existing orders, which (if any) live project should be REUSED when
// the deal re-enters "quoting", so we never double-create a project #.
//
//   node --test controllers/__tests__/projectForCompany.test.js
//
// pickLiveProjectForCompany / isLiveProject are exported from controllers/orders.js
// and take plain Order POJOs, so they're testable without Mongo.

const test = require('node:test');
const assert = require('node:assert/strict');

const { pickLiveProjectForCompany, isLiveProject } = require('../orders');

const mk = (over = {}) => ({
  _id: over._id || Math.random().toString(36).slice(2),
  projectNumber: '1',
  companyKey: 'acme',
  status: 'quoted',
  archived: false,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

// ── isLiveProject ────────────────────────────────────────────────────────────
test('a freshly quoted project is live', () => {
  assert.equal(isLiveProject(mk({ status: 'quoted' })), true);
});

test('every non-terminal status counts as live', () => {
  for (const s of ['quoted', 'approved', 'placed', 'in_production', 'shipped']) {
    assert.equal(isLiveProject(mk({ status: s })), true, `${s} should be live`);
  }
});

test('delivered (won/completed) and cancelled are NOT live', () => {
  assert.equal(isLiveProject(mk({ status: 'delivered' })), false);
  assert.equal(isLiveProject(mk({ status: 'cancelled' })), false);
});

test('an archived project is never live, even if mid-lifecycle', () => {
  assert.equal(isLiveProject(mk({ status: 'placed', archived: true })), false);
});

test('null / undefined are not live (defensive)', () => {
  assert.equal(isLiveProject(null), false);
  assert.equal(isLiveProject(undefined), false);
});

// ── pickLiveProjectForCompany: idempotency core ──────────────────────────────
test('no orders -> null (a fresh project must be created)', () => {
  assert.equal(pickLiveProjectForCompany([]), null);
  assert.equal(pickLiveProjectForCompany(undefined), null);
});

test('only delivered/cancelled/archived -> null (start fresh for new work)', () => {
  const orders = [
    mk({ status: 'delivered' }),
    mk({ status: 'cancelled' }),
    mk({ status: 'placed', archived: true }),
  ];
  assert.equal(pickLiveProjectForCompany(orders), null);
});

test('one live project -> reuse it (never double-create)', () => {
  const live = mk({ _id: 'L', status: 'approved' });
  const chosen = pickLiveProjectForCompany([mk({ status: 'delivered' }), live]);
  assert.equal(chosen._id, 'L');
});

test('re-entry is stable: same input picks the same project', () => {
  const orders = [
    mk({ _id: 'A', status: 'quoted', createdAt: '2026-02-01T00:00:00Z' }),
    mk({ _id: 'B', status: 'approved', createdAt: '2026-03-01T00:00:00Z' }),
  ];
  const first = pickLiveProjectForCompany(orders);
  const second = pickLiveProjectForCompany(orders);
  assert.equal(first._id, second._id);
});

test('prefers the EARLIEST lifecycle stage (the one being worked) over later ones', () => {
  // A shipped project + a quoted one: the quoted one is where new quoting work
  // belongs, so it wins despite being older.
  const orders = [
    mk({ _id: 'shipped', status: 'shipped', createdAt: '2026-05-01T00:00:00Z' }),
    mk({ _id: 'quoted',  status: 'quoted',  createdAt: '2026-01-01T00:00:00Z' }),
  ];
  assert.equal(pickLiveProjectForCompany(orders)._id, 'quoted');
});

test('within the same stage, the most recent project wins', () => {
  const orders = [
    mk({ _id: 'old', status: 'quoted', createdAt: '2026-01-01T00:00:00Z' }),
    mk({ _id: 'new', status: 'quoted', createdAt: '2026-04-01T00:00:00Z' }),
  ];
  assert.equal(pickLiveProjectForCompany(orders)._id, 'new');
});

test('ignores archived/terminal siblings when a live one exists', () => {
  const orders = [
    mk({ _id: 'dead', status: 'cancelled', createdAt: '2026-06-01T00:00:00Z' }),
    mk({ _id: 'done', status: 'delivered', createdAt: '2026-06-02T00:00:00Z' }),
    mk({ _id: 'live', status: 'in_production', createdAt: '2026-01-01T00:00:00Z' }),
  ];
  assert.equal(pickLiveProjectForCompany(orders)._id, 'live');
});

test('missing createdAt does not throw and still returns a live project', () => {
  const orders = [mk({ _id: 'x', status: 'quoted', createdAt: undefined })];
  assert.equal(pickLiveProjectForCompany(orders)._id, 'x');
});
