// controllers/__tests__/recurringExpenses.test.js
//   node --test controllers/__tests__/recurringExpenses.test.js
// The pure reminder date-math for the owner's recurring operating subscriptions:
// which months are past-due-and-unrecorded (the Finances nag), what the next
// charge date is, and the monthly-outflow rollup. No DB, no clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  periodKey, dueDateFor, expectedDueDates, nextDueDate, expenseStatus, summarize,
} = require('../recurringExpenses');

const TODAY = new Date('2026-07-17T12:00:00Z'); // the demo "now"
const sub = (over) => ({
  name: 'X', amount: 10, cadence: 'monthly', dueDay: 1, brand: 'contact',
  startDate: new Date('2026-07-01T00:00:00Z'), active: true, remindersOn: true,
  archived: false, periods: [], ...over,
});

test('periodKey: monthly is YYYY-MM, annual is YYYY', () => {
  assert.equal(periodKey('2026-07-09', 'monthly'), '2026-07');
  assert.equal(periodKey('2026-01-31', 'monthly'), '2026-01');
  assert.equal(periodKey('2026-07-09', 'annual'), '2026');
});

test('dueDateFor: clamps a too-large due day to the month length', () => {
  assert.equal(dueDateFor(2026, 6, 20).toISOString().slice(0, 10), '2026-07-20'); // Jul 20
  assert.equal(dueDateFor(2026, 1, 31).toISOString().slice(0, 10), '2026-02-28'); // Feb → 28
  assert.equal(dueDateFor(2024, 1, 31).toISOString().slice(0, 10), '2024-02-29'); // leap Feb → 29
  assert.equal(dueDateFor(2026, 3, 31).toISOString().slice(0, 10), '2026-04-30'); // Apr → 30
});

test('awaiting: a due day already elapsed this month with no record nags', () => {
  const s = expenseStatus(sub({ dueDay: 1 }), TODAY); // Google Workspace / Render
  assert.equal(s.state, 'awaiting');
  assert.deepEqual(s.awaiting.map((a) => a.period), ['2026-07']);
  assert.equal(s.nextDue.toISOString().slice(0, 10), '2026-08-01');
});

test('awaiting: mid-month due day (Planet Fitness, 15th) already elapsed → nag', () => {
  const s = expenseStatus(sub({ dueDay: 15 }), TODAY);
  assert.equal(s.state, 'awaiting');
  assert.deepEqual(s.awaiting.map((a) => a.period), ['2026-07']);
});

test('upcoming: a due day later this month is NOT yet due (ChatGPT 19th / Claude 21st)', () => {
  const chatgpt = expenseStatus(sub({ dueDay: 19 }), TODAY);
  assert.equal(chatgpt.state, 'upcoming');
  assert.equal(chatgpt.awaiting.length, 0);
  assert.equal(chatgpt.nextDue.toISOString().slice(0, 10), '2026-07-19');

  const claude = expenseStatus(sub({ dueDay: 21 }), TODAY);
  assert.equal(claude.state, 'upcoming');
  assert.equal(claude.nextDue.toISOString().slice(0, 10), '2026-07-21');
});

test('not_started: a subscription starting later this month never nags yet (backup domain, starts 20th)', () => {
  const s = expenseStatus(sub({ dueDay: 20, startDate: new Date('2026-07-20T00:00:00Z') }), TODAY);
  assert.equal(s.state, 'not_started');
  assert.equal(s.awaiting.length, 0);
  assert.equal(s.nextDue.toISOString().slice(0, 10), '2026-07-20');
});

test('recording a period clears its reminder', () => {
  const s = expenseStatus(sub({ dueDay: 1, periods: [{ period: '2026-07', status: 'recorded' }] }), TODAY);
  assert.equal(s.state, 'upcoming');
  assert.equal(s.awaiting.length, 0);
  assert.equal(s.recordedThisPeriod, true);
});

test('skipping a period also clears its reminder (no cost booked)', () => {
  const s = expenseStatus(sub({ dueDay: 15, periods: [{ period: '2026-07', status: 'skipped' }] }), TODAY);
  assert.equal(s.state, 'upcoming');
  assert.equal(s.awaiting.length, 0);
});

test('a missed prior month AND the current month both nag, oldest first', () => {
  // started June 1, only July would… but start June → June + July due, none recorded
  const s = expenseStatus(sub({ dueDay: 1, startDate: new Date('2026-06-01T00:00:00Z') }), TODAY);
  assert.deepEqual(s.awaiting.map((a) => a.period), ['2026-06', '2026-07']);
  assert.equal(s.awaiting[0].daysOverdue > s.awaiting[1].daysOverdue, true);
});

test('inactive / archived never nags', () => {
  assert.equal(expenseStatus(sub({ active: false }), TODAY).state, 'inactive');
  assert.equal(expenseStatus(sub({ archived: true }), TODAY).state, 'inactive');
});

test('expectedDueDates caps the look-back so a far-past start can’t spawn an unbounded list', () => {
  const dues = expectedDueDates(sub({ dueDay: 1, startDate: new Date('2018-01-01T00:00:00Z') }), TODAY);
  assert.equal(dues.length, 24);
  assert.equal(dues[dues.length - 1].toISOString().slice(0, 10), '2026-07-01'); // ends at the current due
});

test('nextDueDate: annual rolls a year forward', () => {
  const s = sub({ cadence: 'annual', startDate: new Date('2026-03-10T00:00:00Z') });
  assert.equal(nextDueDate(s, TODAY).toISOString().slice(0, 10), '2027-03-10');
});

test('summarize: monthly total blends cadence, reminders honor active + remindersOn', () => {
  const list = [
    sub({ name: 'Workspace', amount: 26.40, dueDay: 1 }),                       // awaiting
    sub({ name: 'ChatGPT', amount: 20, dueDay: 19 }),                            // upcoming
    sub({ name: 'Yearly', amount: 120, cadence: 'annual', startDate: new Date('2026-01-05T00:00:00Z'),
      periods: [{ period: '2026', status: 'recorded' }] }),                      // 10/mo, already recorded
    sub({ name: 'Muted', amount: 99, dueDay: 1, remindersOn: false }),           // awaiting but silenced
  ];
  const out = summarize(list, TODAY);
  assert.equal(out.summary.monthlyTotal, 26.40 + 20 + 10 + 99);
  assert.equal(out.summary.annualTotal, +(out.summary.monthlyTotal * 12).toFixed(2));
  // Workspace nags; ChatGPT upcoming; Yearly's 2026 charge is recorded → no nag;
  // Muted is awaiting but remindersOn:false → excluded.
  assert.deepEqual(out.reminders.map((r) => r.name), ['Workspace']);
  assert.equal(out.summary.count, 4);
});
