// controllers/__tests__/time.test.js
//
// The business-timezone (America/New_York) day-boundary helpers. The whole point
// of utils/time.js is that the UTC server must not decide "today" for an owner on
// Eastern time — so these tests PIN the boundary case that motivated the fix:
//   an instant that is already 6/24 in UTC is still 6/23 in Eastern, and must
//   classify as the 23rd.
// They also lock DST behavior (EDT/UTC-4 in summer vs EST/UTC-5 in winter) and the
// whole-day-vs-today comparison used by the CRM. No DB, no extra deps:
//
//   node --test controllers/__tests__/time.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BUSINESS_TZ,
  etToday,
  etDayKey,
  utcDayKey,
  dayDiffFromToday,
  etStartOfToday,
  etEndOfToday,
  etStartOfDay,
  tzOffsetMs,
} = require('../../utils/time');

// Render an instant as wall-clock in ET, to prove a boundary lands where we say.
const inET = (d) => new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(d);

// ── The motivating case ───────────────────────────────────────────────────────
test('an instant that is 6/24 in UTC is still 6/23 in Eastern', () => {
  // 2026-06-24 01:00 UTC == 2026-06-23 21:00 EDT — the evening that broke "today".
  const evening = new Date('2026-06-24T01:00:00Z');
  assert.equal(etToday(evening), '2026-06-23');     // owner's day is the 23rd
  assert.equal(evening.toISOString().slice(0, 10), '2026-06-24'); // UTC says the 24th
});

test('etToday rolls over only at ET midnight, not UTC midnight', () => {
  // 03:59 UTC is still 23:59 the previous day in EDT.
  assert.equal(etToday(new Date('2026-06-24T03:59:00Z')), '2026-06-23');
  // 04:00 UTC == 00:00 EDT → now it's the 24th in ET.
  assert.equal(etToday(new Date('2026-06-24T04:00:00Z')), '2026-06-24');
});

// ── DST is handled automatically (offset derived from the instant) ────────────
test('summer is EDT (UTC-4), winter is EST (UTC-5)', () => {
  assert.equal(tzOffsetMs(new Date('2026-06-15T12:00:00Z'), BUSINESS_TZ), -4 * 3600000);
  assert.equal(tzOffsetMs(new Date('2026-01-15T12:00:00Z'), BUSINESS_TZ), -5 * 3600000);
});

test('etStartOfToday is ET midnight as the correct UTC instant (both seasons)', () => {
  // Summer: 6/23 ET midnight == 04:00Z (EDT -4).
  const summer = etStartOfToday(new Date('2026-06-24T01:00:00Z')); // ET day = 6/23
  assert.equal(summer.toISOString(), '2026-06-23T04:00:00.000Z');
  assert.equal(inET(summer), '06/23/2026, 00:00');
  // Winter: 1/9 ET midnight == 05:00Z (EST -5).
  const winter = etStartOfToday(new Date('2026-01-10T03:00:00Z')); // ET day = 1/9
  assert.equal(winter.toISOString(), '2026-01-09T05:00:00.000Z');
  assert.equal(inET(winter), '01/09/2026, 00:00');
});

test('etEndOfToday is the same ET day at 23:59:59.999', () => {
  const end = etEndOfToday(new Date('2026-06-24T01:00:00Z')); // ET day = 6/23
  assert.equal(end.toISOString(), '2026-06-24T03:59:59.999Z');
  assert.equal(inET(end), '06/23/2026, 23:59');
  // start ≤ a moment in the day ≤ end.
  const start = etStartOfToday(new Date('2026-06-24T01:00:00Z'));
  assert.ok(start.getTime() < end.getTime());
});

test('etStartOfDay walks whole ET days and re-snaps across a DST change', () => {
  // 2026 spring-forward is Sun Mar 8. Start from Mar 7 (EST) and step +1 day into
  // EDT; the boundary must still be local midnight, not 23:00 or 01:00.
  const mar7 = new Date('2026-03-07T12:00:00Z'); // ET day = 3/7 (EST)
  const next = etStartOfDay(1, mar7);            // → 3/8 ET midnight (EST, the gap is later)
  assert.equal(inET(next), '03/08/2026, 00:00');
  const dayAfter = etStartOfDay(2, mar7);        // → 3/9 ET midnight (EDT)
  assert.equal(inET(dayAfter), '03/09/2026, 00:00');
});

// ── Whole-day key helpers ─────────────────────────────────────────────────────
test('utcDayKey reads a whole-day field by its (intended) UTC calendar day', () => {
  // A "2026-06-24" follow-up is stored at UTC midnight; its day is the 24th.
  assert.equal(utcDayKey(new Date('2026-06-24T00:00:00Z')), '2026-06-24');
  assert.equal(utcDayKey('2026-06-24T00:00:00.000Z'), '2026-06-24');
  assert.equal(utcDayKey(null), '');
  assert.equal(utcDayKey('not a date'), '');
});

test('etDayKey buckets a real instant by the owner Eastern day', () => {
  // The same instant the UTC clock calls the 24th is the owner's 23rd.
  assert.equal(etDayKey(new Date('2026-06-24T01:00:00Z')), '2026-06-23');
  assert.equal(etDayKey(null), '');
});

// ── The comparison the CRM actually uses ──────────────────────────────────────
test('dayDiffFromToday compares whole-day (UTC) field to ET today', () => {
  const eveningOf23 = new Date('2026-06-24T01:00:00Z'); // ET today = 6/23
  const fu = (ymd) => new Date(`${ymd}T00:00:00Z`);     // a stored whole-day value

  // A 6/24 follow-up is NOT overdue and NOT due-today on the evening of the 23rd —
  // it's tomorrow. (The bug made this look like "today" because the server was UTC.)
  assert.equal(dayDiffFromToday(fu('2026-06-24'), eveningOf23), 1);
  // A 6/23 follow-up is due TODAY.
  assert.equal(dayDiffFromToday(fu('2026-06-23'), eveningOf23), 0);
  // A 6/21 follow-up is 2 days overdue.
  assert.equal(dayDiffFromToday(fu('2026-06-21'), eveningOf23), -2);
  // Once it's actually 6/24 in ET, that same 6/24 follow-up is due today.
  const eveningOf24 = new Date('2026-06-25T01:00:00Z'); // ET today = 6/24
  assert.equal(dayDiffFromToday(fu('2026-06-24'), eveningOf24), 0);
  // Missing value → null (caller treats as "no follow-up").
  assert.equal(dayDiffFromToday(null, eveningOf23), null);
});
