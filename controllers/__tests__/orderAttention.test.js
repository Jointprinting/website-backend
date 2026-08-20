// Pins the hub command-center order-age logic: the placed-date anchor (when the
// turnaround clock starts) and the whole-ET-day age that drives the 2-week
// "running long" / 3-week "possibly late" flags.
//
//   node --test controllers/__tests__/orderAttention.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { orderPlacedAt, etAgeDays, orderPlacedDayKey, etAgeDaysFromKey } = require('../orders');

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


// ── Whole-day vs instant: the placement day key ──────────────────────────────
// orderDate is a pure CALENDAR date stored at UTC midnight (confirmationPdf
// renders it in UTC for the same reason), while a placed event and createdAt are
// real instants. utils/time warns not to put a whole-day field through etDayKey.
// Running all three through it aged any order dated from orderDate by an extra
// day, so both alarms fired early.

test('orderPlacedDayKey: orderDate keeps its own calendar day, not the ET shift', () => {
  // 2026-08-06T00:00:00Z reads as 2026-08-05 in ET. It must stay the 6th.
  assert.equal(orderPlacedDayKey({ orderDate: '2026-08-06T00:00:00.000Z', activity: [] }), '2026-08-06');
});

test('orderPlacedDayKey: a placed EVENT is an instant, so it uses its ET day', () => {
  const o = { activity: [{ kind: 'status_changed', meta: { to: 'placed' }, at: '2026-08-06T02:30:00.000Z' }] };
  // 02:30Z on the 6th is 10:30pm ET on the 5th — the owner's day is the 5th.
  assert.equal(orderPlacedDayKey(o), '2026-08-05');
});

test('orderPlacedDayKey: createdAt is an instant too', () => {
  assert.equal(orderPlacedDayKey({ createdAt: '2026-08-06T02:30:00.000Z', activity: [] }), '2026-08-05');
});

test('orderPlacedDayKey: nothing to go on → empty, and the age is null', () => {
  assert.equal(orderPlacedDayKey({ activity: [] }), '');
  assert.equal(etAgeDaysFromKey(''), null);
});

test('an orderDate-dated job no longer trips an alarm a day early', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');   // ET day 2026-08-20
  const o = { orderDate: '2026-08-06T00:00:00.000Z', activity: [] };
  // The 6th to the 20th is 14 days -> "running long" starts exactly today.
  assert.equal(etAgeDaysFromKey(orderPlacedDayKey(o), now), 14);
  // The old path read the 5th and called it 15 -> the flag lit a day early.
  assert.equal(etAgeDays(o.orderDate, now), 15);
});

test('the 21-day possibly-late boundary shifts by the same day', () => {
  const now = new Date('2026-08-27T12:00:00.000Z');
  const o = { orderDate: '2026-08-06T00:00:00.000Z', activity: [] };
  assert.equal(etAgeDaysFromKey(orderPlacedDayKey(o), now), 21);
  assert.equal(etAgeDays(o.orderDate, now), 22);
});
