// services/__tests__/agentAnalytics.test.js
//
// The point of this module is that it REFUSES to report statistics the data
// can't support. Most of these tests are about what it declines to say — a
// churn percentage on two reps, a median of nothing, a peer comparison at N=1.
// If a future edit makes any of those render a number, the dashboard starts
// lying and these fail.
//
//   node --test services/__tests__/agentAnalytics.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_DENOM_RATE, MIN_ROSTER_COHORT, MIN_ROSTER_PEER,
  rate, median, scorecard, rosterSummary, survivalLanes,
} = require('../agentAnalytics');

const NOW = new Date('2026-08-13T00:00:00Z');
const d = (s) => new Date(s + 'T00:00:00Z');

// ── the suppression primitive ────────────────────────────────────────────────

test('rate() refuses to divide when the denominator is too small', () => {
  const r = rate(1, 3);
  assert.equal(r.value, null, 'no number at all — not 33%');
  assert.equal(r.suppressed, true);
  assert.equal(r.numerator, 1);
  assert.equal(r.denominator, 3, 'the raw counts survive so the UI can show them instead');
});

test('rate() computes once the denominator earns it', () => {
  const r = rate(3, 20);
  assert.equal(r.suppressed, false);
  assert.equal(r.value, 15);
});

test('rate() is inclusive exactly at the threshold', () => {
  assert.equal(rate(1, MIN_DENOM_RATE).suppressed, false);
  assert.equal(rate(1, MIN_DENOM_RATE - 1).suppressed, true);
});

test('median of nothing is null, not zero', () => {
  assert.equal(median([]), null, 'zero would read as a real result');
  assert.equal(median(undefined), null);
  assert.equal(median([5]), 5);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([3, 1, 2]), 2);
});

test('median ignores non-numeric junk rather than producing NaN', () => {
  assert.equal(median([1, null, 3, undefined, NaN]), 2);
});

// ── the scorecard ────────────────────────────────────────────────────────────

const agentA = {
  _id: 'a1', displayName: 'Alvin', status: 'active',
  startedSellingAt: d('2026-01-01'), createdAt: d('2025-12-01'),
  seatCostMonthly: 8, onboardingCostOnce: 50,
  supportLog: [{ minutes: 60 }, { minutes: 30 }],
  lastLoginAt: d('2026-08-12'),
};
const ordersA = [
  { orderDate: d('2026-02-01'), state: 'earned', revenue: 1682.86, profit: 846.65, commission: 253.99, deliveredDate: d('2026-02-20') },
  { orderDate: d('2026-04-01'), state: 'earned', revenue: 1906.34, profit: 291.22, commission: 87.37, deliveredDate: d('2026-04-25') },
  { orderDate: d('2026-07-01'), state: 'pending', revenue: 900, profit: 250, commission: 75 },
];

test('net contribution nets commission AND cost-to-carry off sourced profit', () => {
  const c = scorecard({ agent: agentA, orders: ordersA, now: NOW, supportRate: 50 });
  assert.equal(c.grossProfitSourced, 1387.87);
  assert.equal(c.commissionEarned, 416.36);
  // 7.4 months on at $8/mo seat + $50 setup + 1.5h at $50 = 59.2 + 50 + 75
  assert.ok(c.carryCost > 180 && c.carryCost < 190, `carryCost ${c.carryCost}`);
  assert.equal(c.netContribution, Math.round((1387.87 - 416.36 - c.carryCost) * 100) / 100);
  assert.ok(c.netContribution < c.grossProfitSourced - c.commissionEarned,
    'carrying someone is never free');
});

test('time to first sale runs from CLEARED-TO-SELL, not account creation', () => {
  const c = scorecard({ agent: agentA, orders: ordersA, now: NOW });
  // startedSellingAt 2026-01-01 → first earned order 2026-02-01 = 31 days.
  assert.equal(c.daysToFirstSale, 31, 'a slow paperwork month is not charged to the rep');
});

test('a rep with no earned orders has a NULL ramp, not a zero', () => {
  const c = scorecard({ agent: agentA, orders: [{ orderDate: d('2026-03-01'), state: 'pending', profit: 100 }], now: NOW });
  assert.equal(c.daysToFirstSale, null);
  assert.equal(c.ordersEarned, 0);
});

test('median margin measures price discipline, not volume', () => {
  const c = scorecard({ agent: agentA, orders: ordersA, now: NOW });
  // 50.3%, 15.3%, 27.8% → median 27.8
  assert.equal(c.medianMarginPct, 27.8);
});

test('disengagement flags on a stale login OR a stale last order', () => {
  const stale = scorecard({
    agent: { ...agentA, lastLoginAt: d('2026-06-01') }, orders: ordersA, now: NOW,
  });
  assert.equal(stale.disengaged, true);

  const fresh = scorecard({
    agent: { ...agentA, lastLoginAt: d('2026-08-12') },
    orders: [{ orderDate: d('2026-08-05'), state: 'earned', revenue: 100, profit: 50, commission: 15, deliveredDate: d('2026-08-06') }],
    now: NOW,
  });
  assert.equal(fresh.disengaged, false);
});

test('tenure stops at departure, it does not keep running', () => {
  const gone = scorecard({
    agent: { ...agentA, status: 'departed', departedAt: d('2026-03-01') }, orders: ordersA, now: NOW,
  });
  assert.equal(gone.tenureDays, 59, 'Jan 1 → Mar 1');
  const still = scorecard({ agent: agentA, orders: ordersA, now: NOW });
  assert.ok(still.tenureDays > 200);
});

test('the sold-but-unpaid gap is measured — it is where unpaid reps quit', () => {
  const c = scorecard({ agent: agentA, orders: ordersA, now: NOW });
  assert.equal(c.medianDaysToPaid, 21.5, 'median of 19 and 24 days');
});

// ── roster rollup: the N-awareness ───────────────────────────────────────────

const cards = (n, over = {}) => Array.from({ length: n }, (_, i) => scorecard({
  agent: { _id: `x${i}`, displayName: `Rep ${i}`, status: 'active', startedSellingAt: d('2026-05-01'), ...over },
  orders: [], now: NOW,
}));

test('churn is SUPPRESSED at a tiny roster and the raw counts survive', () => {
  const s = rosterSummary({ cards: cards(2), now: NOW });
  assert.equal(s.churn.suppressed, true, 'never render a churn % on 2 reps');
  assert.equal(s.churn.value, null);
  assert.equal(s.departures, 0);
  assert.ok(s.exposureRepMonths > 0, 'exposure in rep-months is the honest thing to show');
});

test('with zero departures it reports the rule-of-three UPPER BOUND, not 0%', () => {
  const s = rosterSummary({ cards: cards(2), now: NOW });
  assert.equal(s.churnUpperBound, Math.round((3 / s.exposureRepMonths) * 1000) / 10);
  assert.notEqual(s.churn.value, 0, '"0% churn" would be a claim the data cannot support');
});

test('cohort and peer views stay locked until the roster earns them', () => {
  const tiny = rosterSummary({ cards: cards(1), now: NOW });
  assert.equal(tiny.unlocks.peerComparison, false);
  assert.equal(tiny.unlocks.cohortRetention, false);

  const mid = rosterSummary({ cards: cards(MIN_ROSTER_PEER), now: NOW });
  assert.equal(mid.unlocks.peerComparison, true);
  assert.equal(mid.unlocks.cohortRetention, false, 'peer comparison unlocks before cohorts');

  const big = rosterSummary({ cards: cards(MIN_ROSTER_COHORT), now: NOW });
  assert.equal(big.unlocks.cohortRetention, true);
});

test('headcount splits by status and departed reps leave the live count', () => {
  const live = cards(3);
  const gone = scorecard({
    agent: { _id: 'g', status: 'departed', startedSellingAt: d('2026-01-01'), departedAt: d('2026-04-01') },
    orders: [], now: NOW,
  });
  const s = rosterSummary({ cards: [...live, gone], now: NOW });
  assert.equal(s.headcount.total, 4);
  assert.equal(s.headcount.active, 3);
  assert.equal(s.headcount.departed, 1);
});

test('an empty roster produces nulls, not zeros, for the medians', () => {
  const s = rosterSummary({ cards: [], now: NOW });
  assert.equal(s.netContributionMedian, null);
  assert.equal(s.medianDaysToFirstSale, null);
  assert.equal(s.rampSample, 0);
  assert.equal(s.churn.suppressed, true);
});

test('support hours logged is reported so "free" is never implied', () => {
  const withSupport = scorecard({
    agent: { ...agentA, supportLog: [{ minutes: 45 }] }, orders: [], now: NOW,
  });
  assert.equal(rosterSummary({ cards: [withSupport], now: NOW }).supportMinutesLogged, 45);
  assert.equal(rosterSummary({ cards: cards(2), now: NOW }).supportMinutesLogged, 0,
    'zero logged is distinguishable from zero spent — the UI says "not tracked"');
});

// ── survival lanes: what replaces a retention curve at small N ───────────────

test('survival lanes are named rows in start order, with no percentages', () => {
  const gone = scorecard({
    agent: { _id: 'g', displayName: 'Early', status: 'departed', startedSellingAt: d('2026-01-01'), departedAt: d('2026-03-01') },
    orders: [], now: NOW,
  });
  const lanes = survivalLanes({ cards: [...cards(2), gone], now: NOW });
  assert.equal(lanes.length, 3);
  assert.equal(lanes[0].name, 'Early', 'earliest start first');
  assert.equal(lanes[0].stillOn, false);
  assert.equal(lanes[1].stillOn, true);
  assert.ok(!('retentionPct' in lanes[0]), 'no rate is computed per lane');
});
