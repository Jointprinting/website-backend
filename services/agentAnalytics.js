// services/agentAnalytics.js
//
// Roster analytics. Pure functions over already-fetched rows — no DB, no
// Express — so every number is unit-testable and the controller stays a
// data-loader.
//
// THE RULE THIS MODULE EXISTS TO ENFORCE: never render a statistic the data
// cannot support. A churn percentage on two reps is not a small number, it is a
// meaningless one, and putting it on a dashboard makes the whole screen less
// trustworthy. So every rate here carries the denominator it was computed from,
// and `suppressed: true` when that denominator is too small — the UI shows the
// raw counts instead and says why. Nothing is silently rounded into a lie.
//
// The north star is NET CONTRIBUTION per agent: the gross profit they sourced,
// minus their commission, minus what they cost to carry. Profit alone flatters
// anyone whose seat costs more than they sell; commission alone ignores that
// their orders still made money. One number, and it is the one that answers
// keep / coach / cut.

const MS_DAY = 86400000;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n) => Math.round((num(n) + Number.EPSILON) * 100) / 100;
const asDate = (v) => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? null : d;
};
const daysBetween = (a, b) => (!a || !b ? null : Math.max(0, Math.round((b - a) / MS_DAY)));

// Minimum denominators below which a rate is not reported. These are not
// arbitrary: a proportion from fewer than ~10 observations has a confidence
// interval so wide it spans most of the possible range, and cohort retention
// needs enough reps per cohort that one person leaving isn't a 50% swing.
const MIN_DENOM_RATE = 10;      // any percentage
const MIN_ROSTER_COHORT = 8;    // cohort/retention views
const MIN_ROSTER_PEER = 5;      // "vs the team" comparisons

// A rate that knows whether it is allowed to exist.
function rate(numerator, denominator, minDenom = MIN_DENOM_RATE) {
  const d = num(denominator);
  const n = num(numerator);
  if (d < minDenom) {
    return { value: null, numerator: n, denominator: d, suppressed: true, minDenom };
  }
  return { value: Math.round((n / d) * 1000) / 10, numerator: n, denominator: d, suppressed: false, minDenom };
}

// Median that returns null on an empty set rather than NaN or 0 — a median of
// nothing is not zero, and rendering it as zero would read as a real result.
function median(values) {
  const v = (values || []).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : round2((v[mid - 1] + v[mid]) / 2);
}

// ── Per-agent scorecard ──────────────────────────────────────────────────────
//
// `orders` are that agent's SOURCED orders (originAgentId === them) already
// carrying { profit, revenue, state, orderDate, commission } from the same
// commission math the agent's own Earnings tab uses, so the owner's view and
// the agent's view can never disagree.
function scorecard({ agent, orders = [], now = new Date(), supportRate = 0 } = {}) {
  const a = agent || {};
  const startedAt = asDate(a.startedSellingAt) || asDate(a.createdAt);
  const endedAt = asDate(a.departedAt);
  const tenureDays = daysBetween(startedAt, endedAt || now);

  const sold = orders.filter((o) => o && o.state === 'earned');
  const firstSold = sold
    .map((o) => asDate(o.orderDate))
    .filter(Boolean)
    .sort((x, y) => x - y)[0] || null;

  // Time to first sale — measured from when they were CLEARED to sell, not from
  // when the account was made, so slow paperwork isn't charged to the rep.
  const daysToFirstSale = daysBetween(startedAt, firstSold);

  // The gap that quietly kills unpaid 1099 reps: sold, but not yet paid. With a
  // 3-4 week turnaround plus manual invoicing, this can run long enough that a
  // rep concludes the job doesn't pay and leaves before their first cheque.
  const paidGaps = sold
    .map((o) => daysBetween(asDate(o.orderDate), asDate(o.paidAt) || asDate(o.deliveredDate)))
    .filter((d) => d != null);

  const grossProfitSourced = round2(orders.reduce((s, o) => s + num(o.profit), 0));
  const commissionEarned = round2(orders.reduce((s, o) => s + num(o.commission), 0));
  const revenueSourced = round2(orders.reduce((s, o) => s + num(o.revenue), 0));

  // Cost to carry: seat rent for however long they have been on, plus the one-off
  // to get them going, plus the owner's own hours at whatever those are worth.
  const monthsOn = tenureDays == null ? 0 : tenureDays / 30.44;
  const seatCost = round2(num(a.seatCostMonthly) * monthsOn);
  const supportMinutes = (a.supportLog || []).reduce((s, e) => s + num(e && e.minutes), 0);
  const supportCost = round2((supportMinutes / 60) * num(supportRate));
  const carryCost = round2(seatCost + num(a.onboardingCostOnce) + supportCost);

  // THE number.
  const netContribution = round2(grossProfitSourced - commissionEarned - carryCost);

  const lastOrderAt = orders.map((o) => asDate(o.orderDate)).filter(Boolean).sort((x, y) => y - x)[0] || null;
  const lastSeenAt = asDate(a.lastLoginAt);
  const daysSinceOrder = daysBetween(lastOrderAt, now);
  const daysSinceLogin = daysBetween(lastSeenAt, now);

  return {
    id: String(a._id || a.id || ''),
    name: a.displayName || a.username || '',
    status: a.status || (a.active === false ? 'paused' : 'onboarding'),
    startedAt, endedAt, tenureDays,
    recruitSource: a.recruitSource || '',
    territory: a.territory || '',

    orders: orders.length,
    ordersEarned: sold.length,
    revenueSourced,
    grossProfitSourced,
    commissionEarned,
    seatCost, supportMinutes, supportCost,
    carryCost,
    netContribution,

    // Margin discipline — are they holding price, or buying deals with your money?
    medianMarginPct: median(orders
      .filter((o) => num(o.revenue) > 0)
      .map((o) => Math.round((num(o.profit) / num(o.revenue)) * 1000) / 10)),

    daysToFirstSale,
    medianDaysToPaid: median(paidGaps),
    daysSinceOrder,
    daysSinceLogin,
    // A disengagement flag, not a leaderboard. Login count is a terrible measure
    // of effort and a decent measure of "has this person stopped showing up".
    disengaged: (daysSinceLogin != null && daysSinceLogin > 14) || (daysSinceOrder != null && daysSinceOrder > 45),

    disposition: a.disposition || '',
    dispositionAt: asDate(a.dispositionAt),
  };
}

// ── Roster rollup ────────────────────────────────────────────────────────────
//
// Everything here is N-aware. `unlocks` tells the UI which views are honest at
// the current roster size so the gating lives in one place rather than being
// re-decided per component.
function rosterSummary({ cards = [], now = new Date() } = {}) {
  const all = cards || [];
  const live = all.filter((c) => c.status === 'active' || c.status === 'onboarding');
  const departed = all.filter((c) => c.status === 'departed');

  // Exposure in REP-MONTHS — the correct denominator for churn, and the honest
  // one to show when there isn't enough of it to compute a rate. "No departures
  // in 9 rep-months" is a true, useful sentence; "0% churn" is not.
  const repMonths = round2(all.reduce((s, c) => s + (c.tenureDays == null ? 0 : c.tenureDays / 30.44), 0));
  const churn = rate(departed.length, repMonths, MIN_DENOM_RATE);
  // With zero events, the honest statement is an upper bound, not a rate: the
  // rule of three says ~3/exposure is the most you can rule out at 95%.
  const churnUpperBound = departed.length === 0 && repMonths > 0
    ? Math.round((3 / repMonths) * 1000) / 10
    : null;

  const contributions = all.map((c) => c.netContribution).filter(Number.isFinite);
  const ramps = all.map((c) => c.daysToFirstSale).filter((d) => d != null);

  return {
    headcount: {
      total: all.length,
      active: all.filter((c) => c.status === 'active').length,
      onboarding: all.filter((c) => c.status === 'onboarding').length,
      paused: all.filter((c) => c.status === 'paused').length,
      departed: departed.length,
    },
    netContributionTotal: round2(contributions.reduce((s, v) => s + v, 0)),
    netContributionMedian: median(contributions),
    grossProfitSourcedTotal: round2(all.reduce((s, c) => s + num(c.grossProfitSourced), 0)),
    commissionTotal: round2(all.reduce((s, c) => s + num(c.commissionEarned), 0)),
    carryCostTotal: round2(all.reduce((s, c) => s + num(c.carryCost), 0)),

    medianDaysToFirstSale: median(ramps),
    rampSample: ramps.length,

    exposureRepMonths: repMonths,
    departures: departed.length,
    churn,                 // .suppressed until the exposure supports a rate
    churnUpperBound,       // the rule-of-three ceiling while there are no events

    // Which views are honest right now. The UI reads these instead of hard-coding
    // thresholds, so raising a bar later is a one-line change here.
    unlocks: {
      peerComparison: live.length >= MIN_ROSTER_PEER,
      cohortRetention: all.length >= MIN_ROSTER_COHORT,
      anyRates: repMonths >= MIN_DENOM_RATE,
      minRosterPeer: MIN_ROSTER_PEER,
      minRosterCohort: MIN_ROSTER_COHORT,
    },
    // Support capacity is the real ceiling on a solo-owner network. Surfaced as a
    // fact, not a target — and explicitly "unknown" until hours are actually logged.
    supportMinutesLogged: all.reduce((s, c) => s + num(c.supportMinutes), 0),
  };
}

// Named survival lanes — what a retention view should show BELOW the cohort
// threshold. One row per rep with their start, their milestones and their end.
// No percentages, because with this many people a percentage is theatre.
function survivalLanes({ cards = [], now = new Date() } = {}) {
  return (cards || [])
    .slice()
    .sort((a, b) => (asDate(a.startedAt) || 0) - (asDate(b.startedAt) || 0))
    .map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      tenureDays: c.tenureDays,
      firstSaleDay: c.daysToFirstSale,
      ordersEarned: c.ordersEarned,
      netContribution: c.netContribution,
      stillOn: c.status !== 'departed',
    }));
}

module.exports = {
  MIN_DENOM_RATE, MIN_ROSTER_COHORT, MIN_ROSTER_PEER,
  rate, median, scorecard, rosterSummary, survivalLanes,
};
