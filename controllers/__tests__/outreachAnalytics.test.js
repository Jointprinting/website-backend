// controllers/__tests__/outreachAnalytics.test.js
//
// Pure-logic checks for the outreach analytics + email verification helpers:
//   node --test controllers/__tests__/outreachAnalytics.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseState, buildStateFunnels, weeklyTrend, weekStartMs } = require('../outreach');
const { isLikelyEmail, emailDomain, partitionDeliverable } = require('../../services/emailVerify');

// ── State parsing ────────────────────────────────────────────────────────────
test('parseState pulls a valid US state, else empty', () => {
  assert.equal(parseState('12 High St, Trenton NJ 08601'), 'NJ');
  assert.equal(parseState('12 High St, Trenton, NJ 08601'), 'NJ');
  assert.equal(parseState('5 Main St, Newark, NJ'), 'NJ');
  assert.equal(parseState('123 Pine Ave, Denver CO 80014'), 'CO');
  assert.equal(parseState('somewhere, ZZ 99999'), '');   // ZZ isn't a state
  assert.equal(parseState('no state here'), '');
  assert.equal(parseState(''), '');
});

// ── Per-state funnel ─────────────────────────────────────────────────────────
test('buildStateFunnels groups by state and orders by leads, Unknown last', () => {
  const enrollments = [
    { companyKey: 'a', sends: [{}], openCount: 1, status: 'replied' },
    { companyKey: 'b', sends: [{}], status: 'active' },
    { companyKey: 'c', sends: [], status: 'active' },              // NJ, not yet sent
    { companyKey: 'd', sends: [{}], status: 'unsubscribed' },       // NY
    { companyKey: 'e', sends: [{}], status: 'active' },             // no state → Unknown
  ];
  const stateByKey = new Map([['a', 'NJ'], ['b', 'NJ'], ['c', 'NJ'], ['d', 'NY'], ['e', '']]);
  const rows = buildStateFunnels(enrollments, stateByKey);
  assert.equal(rows[0].state, 'NJ');           // 3 leads → first
  assert.equal(rows[0].leads, 3);
  assert.equal(rows[0].sent, 2);
  assert.equal(rows[0].opened, 1);
  assert.equal(rows[0].replied, 1);
  assert.equal(rows[1].state, 'NY');
  assert.equal(rows[1].unsubscribed, 1);
  assert.equal(rows[rows.length - 1].state, 'Unknown'); // always last
});

// ── Weekly trend ─────────────────────────────────────────────────────────────
test('weekStartMs snaps to Monday UTC midnight', () => {
  // 2026-07-02 is a Thursday → week's Monday is 2026-06-29.
  assert.equal(weekStartMs(Date.UTC(2026, 6, 2, 15, 0, 0)), Date.UTC(2026, 5, 29));
  // A Monday maps to itself.
  assert.equal(weekStartMs(Date.UTC(2026, 5, 29, 0, 0, 0)), Date.UTC(2026, 5, 29));
});

test('weeklyTrend buckets sends/opens/replies into the right weeks', () => {
  const now = Date.UTC(2026, 6, 2, 12, 0, 0); // Thu 2026-07-02
  const thisWeek = Date.UTC(2026, 5, 29);
  const lastWeek = thisWeek - 7 * 86400000;
  const enrollments = [
    { sends: [{ at: new Date(now), openedAt: new Date(now) }], repliedAt: new Date(now) },
    { sends: [{ at: new Date(lastWeek + 3 * 86400000) }] }, // a send last week
  ];
  const trend = weeklyTrend(enrollments, now, 8);
  assert.equal(trend.length, 8);
  const cur = trend[trend.length - 1];
  assert.equal(cur.weekStart, thisWeek);
  assert.equal(cur.sent, 1);
  assert.equal(cur.opened, 1);
  assert.equal(cur.replied, 1);
  assert.equal(trend[trend.length - 2].sent, 1); // last week
  assert.equal(trend[0].sent, 0);                // 8 weeks ago, nothing
});

// ── Email verification (pure parts) ──────────────────────────────────────────
test('isLikelyEmail / emailDomain', () => {
  assert.equal(isLikelyEmail('info@greenleaf.com'), true);
  assert.equal(isLikelyEmail('INFO@Green-Leaf.co'), true);
  assert.equal(isLikelyEmail('nope'), false);
  assert.equal(isLikelyEmail('a@b'), false);
  assert.equal(emailDomain('Info@GreenLeaf.com'), 'greenleaf.com');
  assert.equal(emailDomain('bad'), '');
});

test('partitionDeliverable keeps only syntactically-valid, MX-backed emails', () => {
  const cands = [
    { email: 'info@good.com' },
    { email: 'sales@nomx.com' },
    { email: 'bad-syntax' },
    { email: '' },
  ];
  const mx = new Map([['good.com', true], ['nomx.com', false]]);
  const { good, bad } = partitionDeliverable(cands, mx);
  assert.equal(good.length, 1);
  assert.equal(good[0].email, 'info@good.com');
  assert.equal(bad.length, 3);
});
