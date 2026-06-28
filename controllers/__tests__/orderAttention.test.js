// Pins the hub command-center order-age logic: the placed-date anchor (when the
// turnaround clock starts) and the whole-ET-day age that drives the 2-week
// "running long" / 3-week "possibly late" flags.
//
//   node --test controllers/__tests__/orderAttention.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { orderPlacedAt, etAgeDays } = require('../orders');

// A fixed "now" so the day math is deterministic — midday UTC = morning ET, well
// clear of any day boundary.
const NOW = new Date('2026-06-28T16:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);

// ── the placed-date anchor: status_changed→placed wins, then orderDate, then createdAt ──
test('orderPlacedAt: prefers the status_changed→placed event', () => {
  const placedAt = '2026-06-10T14:00:00Z';
  const o = {
    orderDate: '2026-06-01T00:00:00Z',
    createdAt: '2026-05-20T00:00:00Z',
    activity: [
      { kind: 'created', at: '2026-05-20T00:00:00Z' },
      { kind: 'status_changed', meta: { from: 'approved', to: 'placed' }, at: placedAt },
      { kind: 'status_changed', meta: { from: 'placed', to: 'in_production' }, at: '2026-06-12T00:00:00Z' },
    ],
  };
  assert.equal(orderPlacedAt(o), placedAt);
});

test('orderPlacedAt: falls back to orderDate, then createdAt', () => {
  assert.equal(
    orderPlacedAt({ orderDate: '2026-06-01T00:00:00Z', createdAt: '2026-05-20T00:00:00Z', activity: [{ kind: 'created' }] }),
    '2026-06-01T00:00:00Z',
  );
  assert.equal(
    orderPlacedAt({ orderDate: null, createdAt: '2026-05-20T00:00:00Z', activity: [] }),
    '2026-05-20T00:00:00Z',
  );
  assert.equal(orderPlacedAt({ activity: null }), null);
});

test('orderPlacedAt: uses the EARLIEST placed event if status flipped more than once', () => {
  const first = '2026-06-05T10:00:00Z';
  const o = { activity: [
    { kind: 'status_changed', meta: { to: 'placed' }, at: '2026-06-20T10:00:00Z' },
    { kind: 'status_changed', meta: { to: 'placed' }, at: first },
  ] };
  assert.equal(orderPlacedAt(o), first);
});

// ── the age flags: <14 nothing, 14–20 running long, 21+ possibly late ──
test('etAgeDays: whole-day age across the flag boundaries', () => {
  assert.equal(etAgeDays(daysAgo(0), NOW), 0);
  assert.equal(etAgeDays(daysAgo(13), NOW), 13);   // not yet flagged
  assert.equal(etAgeDays(daysAgo(14), NOW), 14);   // → running long
  assert.equal(etAgeDays(daysAgo(20), NOW), 20);   // still running long
  assert.equal(etAgeDays(daysAgo(21), NOW), 21);   // → possibly late
});

test('etAgeDays: a missing/invalid placed date is null (never flagged)', () => {
  assert.equal(etAgeDays(null, NOW), null);
  assert.equal(etAgeDays('not-a-date', NOW), null);
});

test('etAgeDays: a future placed date is negative (never flagged)', () => {
  assert.ok(etAgeDays(new Date(NOW.getTime() + 3 * 86400000), NOW) < 0);
});
