// controllers/__tests__/quoteTotals.test.js
//
// Pure-logic checks for Order.computeQuoteTotals — the quote-stage money math.
// No DB: computeQuoteTotals is a pure function exported off the model.
//
//   node --test controllers/__tests__/quoteTotals.test.js
//
// The behavior under test (Nate's quoter rework):
//   1. A quote is worth $0 to the pipeline UNTIL the client picks — an un-picked
//      pitch must NOT sum its alternatives into the owner's project totals.
//   2. Once picked, the order = accepted picks + always-included standalone
//      lines; a DECLINED group (pitch 10, take 5) contributes nothing.
//   3. Setup + shipping are each option's FULL one-time cost, spread across that
//      option's own quantity — the per-unit COGS and total COGS must be airtight.
//   4. Unit price falls back to cost × 1.4 (never ×1 = sell-at-cost).

const test = require('node:test');
const assert = require('node:assert/strict');

const Order = require('../../models/Order');
const { computeQuoteTotals } = Order;

// A round-ish fixture: 50 tees, $3 blank, $2 print, $40 setup, $25 shipping.
const tee = (over = {}) => ({
  group: 'Tees', qty: 50, blankCost: 3, printCost: 2,
  setupCost: 40, shippingCost: 25, markup: 1.4, ...over,
});

// ── 1. Un-picked quote = $0 (the core bug) ───────────────────────────────────
test('un-picked quote contributes $0 — no accepted line means no realized value', () => {
  const lines = [
    tee({ group: 'Tees', description: 'Brand A' }),
    tee({ group: 'Tees', description: 'Brand B', blankCost: 5 }),
    tee({ group: 'Hats', description: 'Bucket', qty: 24, blankCost: 8, printCost: 3 }),
  ];
  const t = computeQuoteTotals(lines);
  assert.equal(t.totalValue, 0, 'no total before the client picks');
  assert.equal(t.cogs, 0, 'no COGS before the client picks');
});

test('empty / missing lines are $0, never NaN', () => {
  assert.deepEqual(computeQuoteTotals([]), { totalValue: 0, cogs: 0 });
  assert.deepEqual(computeQuoteTotals(null), { totalValue: 0, cogs: 0 });
  assert.deepEqual(computeQuoteTotals(undefined), { totalValue: 0, cogs: 0 });
});

// ── 2. Picked quote sums only what the client committed to ────────────────────
test('picked quote counts the accepted alternative, not the ones passed on', () => {
  const lines = [
    tee({ description: 'Brand A', accepted: true }),         // picked
    tee({ description: 'Brand B', blankCost: 9, accepted: false }), // passed on
  ];
  const t = computeQuoteTotals(lines);
  // COGS = 50*(3+2) + 40 + 25 = 250 + 65 = 315 (Brand A only)
  assert.equal(t.cogs, 315);
  // unit COGS = 3 + 2 + 65/50 = 6.30; unit price = 6.30 * 1.4 = 8.82; ×50 = 441
  assert.equal(round(t.totalValue), 441);
});

test('a DECLINED group contributes nothing — pitch 10, take 5', () => {
  const lines = [
    tee({ group: 'Tees', description: 'Tee', accepted: true }),
    // Client declined the whole "Hoodies" group — neither alternative accepted.
    tee({ group: 'Hoodies', description: 'Hoodie A', qty: 20, blankCost: 18, accepted: false }),
    tee({ group: 'Hoodies', description: 'Hoodie B', qty: 20, blankCost: 22, accepted: false }),
  ];
  const t = computeQuoteTotals(lines);
  assert.equal(t.cogs, 315, 'only the accepted tee counts');
});

test('standalone (ungrouped) lines are always included once the client picks', () => {
  const lines = [
    tee({ group: 'Tees', description: 'Tee', accepted: true }),
    { qty: 10, blankCost: 1, printCost: 1, setupCost: 0, shippingCost: 0, markup: 1.5 }, // standalone add-on
  ];
  const t = computeQuoteTotals(lines);
  // tee cogs 315 + addon cogs 10*(1+1)=20 → 335
  assert.equal(t.cogs, 335);
});

test('decline every group, keep only the standalone line → books the standalone value, not $0', () => {
  // Mirrors what publicSelectOptions writes: standalone lines are marked
  // accepted (they're always part of the committed order), grouped alternatives
  // the client passed on are not. The selection gate must see the standalone as
  // committed and NOT read this as an un-picked $0 quote.
  const lines = [
    tee({ group: 'Hats', description: 'Passed on', accepted: false }),
    { qty: 10, blankCost: 1, printCost: 1, setupCost: 0, shippingCost: 0, markup: 1.5, accepted: true }, // standalone, kept
  ];
  const t = computeQuoteTotals(lines);
  assert.equal(t.cogs, 20, 'only the standalone line — the declined group contributes nothing');
  assert.equal(round(t.totalValue), 30, '10 × ($2 cogs × 1.5)');
});

// ── 3. Airtight setup + shipping amortization ────────────────────────────────
test('setup + shipping are spread across the option qty into per-unit COGS', () => {
  const lines = [tee({ accepted: true, markup: 1 })]; // explicit markup 1 (sell at cost) is honored
  const t = computeQuoteTotals(lines);
  // unit COGS = 3 + 2 + (40+25)/50 = 5 + 1.30 = 6.30; at markup 1 → 6.30 * 50 = 315
  assert.equal(t.cogs, 315);
  assert.equal(round(t.totalValue), 315, 'markup exactly 1.0 (truthy) is respected as sell-at-cost');
});

test('zero-qty option never divides by zero', () => {
  const lines = [tee({ accepted: true, qty: 0 })];
  const t = computeQuoteTotals(lines);
  assert.equal(t.totalValue, 0);
  // COGS = 0*(5) + 40 + 25 = 65 (the setup/ship are still real costs)
  assert.equal(t.cogs, 65);
});

// ── 4. Markup fallback is 1.4, never sell-at-cost ────────────────────────────
test('missing/zero markup falls back to 1.4, not 1 (never sell at cost by accident)', () => {
  const lines = [tee({ accepted: true, markup: 0, unitPrice: 0 })];
  const t = computeQuoteTotals(lines);
  // unit COGS 6.30 → price 6.30 * 1.4 = 8.82 → ×50 = 441 (NOT 315)
  assert.equal(round(t.totalValue), 441);
});

test('an explicit unit-price override wins over the markup math', () => {
  const lines = [tee({ accepted: true, unitPrice: 10 })];
  const t = computeQuoteTotals(lines);
  assert.equal(t.totalValue, 500, '50 × $10 override');
  assert.equal(t.cogs, 315, 'COGS is independent of the sale price');
});

// ── Legacy order-level setup/shipping (back-compat) ──────────────────────────
test('legacy order-level setup/ship folds in only when no line carries its own', () => {
  const lines = [tee({ accepted: true, setupCost: 0, shippingCost: 0, markup: 1 })];
  const t = computeQuoteTotals(lines, 30, 20); // order-level setup 30 + ship 20
  // cogs = 50*5 + (30+20) = 300; total at markup 1: 50*5=250 + legacy 50 = 300
  assert.equal(t.cogs, 300);
  assert.equal(round(t.totalValue), 300);
});

function round(v) { return Math.round(v * 100) / 100; }
