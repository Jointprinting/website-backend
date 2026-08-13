// services/__tests__/commission.test.js
//
// The commission math is the only place in the app that decides what a person
// is owed, so it is pure and pinned hard. New Jersey's sales-rep statute puts
// treble damages behind paying a rep what they've earned, which makes the
// "earned vs pending" line and the never-negative rule worth a test each rather
// than a comment.
//
//   node --test services/__tests__/commission.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_COMMISSION, normalizeConfig, tierFor, nextTierFor,
  originKind, rateFor, earnedState, commissionForOrder,
} = require('../commission');

// ── normalizeConfig: never throws, never silently pays 0% ────────────────────

test('normalizeConfig falls back to the default ladder on missing/partial input', () => {
  for (const input of [undefined, null, {}, { tiers: [] }, 'nonsense', 42]) {
    const c = normalizeConfig(input);
    assert.equal(c.tiers.length, DEFAULT_COMMISSION.tiers.length, `input ${JSON.stringify(input)}`);
    assert.equal(c.tiers[0].selfPct, 30);
    assert.equal(c.tiers[2].selfPct, 40);
  }
});

test('normalizeConfig sorts tiers by threshold and clamps percentages to 0–100', () => {
  const c = normalizeConfig({
    tiers: [
      { name: 'High', minLifetimeProfit: 900, selfPct: 250, housePct: -8, reorderPct: 10 },
      { name: 'Low', minLifetimeProfit: 0, selfPct: 20, housePct: 10, reorderPct: 10 },
    ],
  });
  assert.deepEqual(c.tiers.map((t) => t.name), ['Low', 'High']);
  assert.equal(c.tiers[1].selfPct, 100, 'over 100 clamps down');
  assert.equal(c.tiers[1].housePct, 0, 'negative clamps up to 0');
});

test('normalizeConfig keeps a negative fastStartOrders from disabling nothing', () => {
  assert.equal(normalizeConfig({ fastStartOrders: -5 }).fastStartOrders, 0);
  assert.equal(normalizeConfig({ fastStartOrders: 2.9 }).fastStartOrders, 2, 'floors');
});

// ── the ladder ───────────────────────────────────────────────────────────────

test('tierFor picks the highest threshold met, and is inclusive at the boundary', () => {
  assert.equal(tierFor(0).name, 'Starter');
  assert.equal(tierFor(2999.99).name, 'Starter');
  assert.equal(tierFor(3000).name, 'Established', 'boundary is inclusive');
  assert.equal(tierFor(8999).name, 'Established');
  assert.equal(tierFor(9000).name, 'Partner');
  assert.equal(tierFor(1e9).name, 'Partner', 'never runs off the top');
});

test('tierFor never returns undefined for a below-lowest-threshold figure', () => {
  const cfg = { tiers: [{ name: 'Only', minLifetimeProfit: 5000, selfPct: 25, housePct: 12, reorderPct: 12 }] };
  assert.equal(tierFor(0, cfg).name, 'Only', 'falls back to the first rung, not nothing');
  assert.equal(tierFor(0, cfg).selfPct, 25);
});

test('nextTierFor reports the gap, and null at the top', () => {
  const at0 = nextTierFor(0);
  assert.equal(at0.name, 'Established');
  assert.equal(at0.remaining, 3000);
  assert.equal(at0.progress, 0);

  const mid = nextTierFor(1500);
  assert.equal(mid.remaining, 1500);
  assert.equal(mid.progress, 0.5);

  assert.equal(nextTierFor(9000), null, 'top tier has no next');
  assert.equal(nextTierFor(50000), null);
});

// ── attribution ──────────────────────────────────────────────────────────────

test('originKind separates all four cases', () => {
  assert.equal(originKind({ sourcedByAgent: true, priorOrdersForCompany: 0 }), 'self');
  assert.equal(originKind({ sourcedByAgent: true, priorOrdersForCompany: 3 }), 'reorder');
  assert.equal(originKind({ sourcedByAgent: false, priorOrdersForCompany: 0 }), 'house');
  assert.equal(originKind({ sourcedByAgent: false, priorOrdersForCompany: 1 }), 'house_reorder');
  assert.equal(originKind(), 'house', 'no argument = not the agent’s');
});

// ── rates ────────────────────────────────────────────────────────────────────

test('a house account pays on the first order only, by default', () => {
  assert.equal(rateFor({ kind: 'house', lifetimeProfit: 0, selfOrdersCompleted: 99 }).pct, 15);
  const repeat = rateFor({ kind: 'house_reorder', lifetimeProfit: 0, selfOrdersCompleted: 99 });
  assert.equal(repeat.pct, 0);
  assert.match(repeat.basis, /first order only/);
});

test('the owner can opt into paying house reorders', () => {
  const cfg = { houseReordersPay: true };
  assert.equal(rateFor({ kind: 'house_reorder', lifetimeProfit: 0, selfOrdersCompleted: 99, config: cfg }).pct, 15);
});

test('self-sourced rate climbs with the ladder', () => {
  const past = { selfOrdersCompleted: 99 };   // fast start spent
  assert.equal(rateFor({ kind: 'self', lifetimeProfit: 0, ...past }).pct, 30);
  assert.equal(rateFor({ kind: 'self', lifetimeProfit: 3000, ...past }).pct, 35);
  assert.equal(rateFor({ kind: 'self', lifetimeProfit: 9000, ...past }).pct, 40);
});

test('fast start lifts the first 3 self orders to tier 2, then stops', () => {
  const at = (n) => rateFor({ kind: 'self', lifetimeProfit: 0, selfOrdersCompleted: n });
  assert.equal(at(0).pct, 35);
  assert.equal(at(0).basis, 'fast start');
  assert.equal(at(2).pct, 35, 'third order still boosted');
  assert.equal(at(3).pct, 30, 'fourth drops to the real tier');
  assert.equal(at(3).basis, 'you found them');
});

test('fast start never LOWERS the rate for an agent already above tier 2', () => {
  const r = rateFor({ kind: 'self', lifetimeProfit: 9000, selfOrdersCompleted: 0 });
  assert.equal(r.pct, 40, 'a Partner starting a new streak keeps 40, not 35');
});

test('fast start is a no-op when the owner sets it to zero', () => {
  const r = rateFor({ kind: 'self', lifetimeProfit: 0, selfOrdersCompleted: 0, config: { fastStartOrders: 0 } });
  assert.equal(r.pct, 30);
});

// ── earned vs pending ────────────────────────────────────────────────────────

test('commission is earned only when delivered AND paid', () => {
  assert.equal(earnedState({ status: 'delivered', paid: true }), 'earned');
  assert.equal(earnedState({ status: 'delivered', paid: false }), 'pending', 'delivered but unpaid is not owed');
  assert.equal(earnedState({ status: 'shipped', paid: true }), 'pending', 'paid but not delivered is not owed');
  assert.equal(earnedState({ status: 'quoted', paid: false }), 'pending');
  assert.equal(earnedState({}), 'pending');
  assert.equal(earnedState(), 'pending', 'no order at all is not owed');
});

test('a deliveredDate counts as delivered even if the status moved on', () => {
  assert.equal(earnedState({ status: 'cancelled', deliveredDate: new Date(), paid: true }), 'earned');
});

// ── the whole calculation ────────────────────────────────────────────────────

test('commissionForOrder pays the rate on gross profit', () => {
  // Order #000001 (JFS) from the real ledger: $846.65 profit before commission.
  const r = commissionForOrder({
    profit: 846.65, kind: 'self', lifetimeProfit: 9000, selfOrdersCompleted: 99, state: 'earned',
  });
  assert.equal(r.ratePct, 40);
  assert.equal(r.commission, 338.66);
  assert.equal(r.profit, 846.65);
  assert.equal(r.state, 'earned');
});

test('the historical 10%-of-profit rate reproduces the real Alvin payment', () => {
  const cfg = { tiers: [{ name: 'Legacy', minLifetimeProfit: 0, selfPct: 10, housePct: 10, reorderPct: 10 }], fastStartOrders: 0 };
  const r = commissionForOrder({ profit: 846.65, kind: 'self', config: cfg });
  assert.equal(r.commission, 84.67, 'matches the $84.67 booked on order #000001');
});

test('a zero-profit land-the-client order pays nothing but does not go negative', () => {
  const zero = commissionForOrder({ profit: 0, kind: 'self', selfOrdersCompleted: 99 });
  assert.equal(zero.commission, 0);
});

test('a LOSS never claws back pay', () => {
  const loss = commissionForOrder({ profit: -834.21, kind: 'self', selfOrdersCompleted: 99 });
  assert.equal(loss.commission, 0, 'no negative commission on a job that lost money');
  assert.equal(loss.profit, -834.21, 'but the real profit is still reported honestly');
});

test('a house reorder computes to zero without special-casing at the call site', () => {
  const r = commissionForOrder({ profit: 1000, kind: 'house_reorder', selfOrdersCompleted: 99 });
  assert.equal(r.commission, 0);
});

test('commission rounds to cents, not floating dust', () => {
  const r = commissionForOrder({ profit: 291.22, kind: 'self', lifetimeProfit: 0, selfOrdersCompleted: 99 });
  assert.equal(r.ratePct, 30);
  assert.equal(r.commission, 87.37);
  assert.equal(Number.isInteger(r.commission * 100), true, 'exact cents');
});

// ── The ladder has to be REACHABLE ───────────────────────────────────────────
//
// The first version used $15,000 / $40,000 of lifetime sourced profit. Against
// a median order profit of ~$317 that is 47 and 126 sourced orders, at a company
// whose entire history is 37 orders — nobody would ever have left Starter, so
// the ladder was a promise that couldn't be kept. This test fails if a future
// edit quietly makes it unreachable again.

test('every tier is reachable within a plausible number of median orders', () => {
  const MEDIAN_ORDER_PROFIT = 317;      // from the verified 2024–26 ledger
  const A_BUSY_YEAR = 40;               // sourced orders a working rep might do
  const cfg = normalizeConfig();
  cfg.tiers.forEach((t, i) => {
    const ordersNeeded = t.minLifetimeProfit / MEDIAN_ORDER_PROFIT;
    assert.ok(
      ordersNeeded <= A_BUSY_YEAR * 2,
      `tier ${i} "${t.name}" needs ${Math.round(ordersNeeded)} median orders — not reachable in two working years`,
    );
  });
});

test('the ladder only ever goes up, rung to rung', () => {
  const { tiers } = normalizeConfig();
  for (let i = 1; i < tiers.length; i += 1) {
    assert.ok(tiers[i].minLifetimeProfit > tiers[i - 1].minLifetimeProfit, 'thresholds strictly increase');
    assert.ok(tiers[i].selfPct >= tiers[i - 1].selfPct, 'self rate never decreases');
    assert.ok(tiers[i].housePct >= tiers[i - 1].housePct, 'house rate never decreases');
  }
});
