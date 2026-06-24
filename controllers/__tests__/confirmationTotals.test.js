// controllers/__tests__/confirmationTotals.test.js
//
// Pure-logic checks for the confirmation grand total and the multi-ship-to
// per-location sales tax (no DB). Runs on Node's built-in test runner:
//
//   node --test controllers/__tests__/confirmationTotals.test.js
//
// computeConfirmationTotals / computeLocationTax are exported from
// models/Order.js and take plain POJOs, so they're testable without Mongo.
// These PIN the money math the builder preview, the PDF, the approval page and
// the order's totalValue/revenue all reuse — and, crucially, assert that a
// single-location (or untaxed) confirmation is byte-identical to before the
// per-location tax pass.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeConfirmationTotals,
  computeLocationTax,
  STATE_TAX_RATES,
} = require('../../models/Order');

// ── Factories ────────────────────────────────────────────────────────────────
// An item with a single size row: qty units at unitPrice each.
const item = (qty, unitPrice, allocations) => ({
  sizes: [{ label: 'OS', qty, unitPrice }],
  ...(allocations ? { allocations } : {}),
});
// An item spread across several sizes (to prove revenue follows total qty).
const sizedItem = (sizes, allocations) => ({
  sizes,
  ...(allocations ? { allocations } : {}),
});

// ── Single-location / no shipTos: UNCHANGED ──────────────────────────────────
test('no shipTos: location tax is inactive and total is items + customLines', () => {
  const conf = {
    items: [item(100, 10), item(50, 20)],            // 1000 + 1000 = 2000
    customLines: [{ label: 'NJ sales tax', amount: 6.625, isPercent: true }],
  };
  const tax = computeLocationTax(conf);
  assert.equal(tax.active, false);
  assert.equal(tax.total, 0);
  assert.deepEqual(tax.lines, []);

  // Grand total = 2000 + 6.625% = 2132.5 (exactly today's behaviour).
  const { itemsSubtotal, grandTotal } = computeConfirmationTotals(conf);
  assert.equal(itemsSubtotal, 2000);
  assert.equal(grandTotal, 2132.5);
});

test('shipTos with all taxRate 0: byte-identical to no shipTos', () => {
  const base = {
    items: [item(100, 10)],
    customLines: [{ label: 'Credit card fee', amount: 2.99, isPercent: true }],
  };
  const withZeroRateShipTos = {
    ...base,
    shipTos: [
      { key: 'a', label: 'HQ', state: 'NJ', taxRate: 0 },
      { key: 'b', label: 'Warehouse', state: '', taxRate: 0 },
    ],
    items: [item(100, 10, [{ key: 'a', qty: 60 }, { key: 'b', qty: 40 }])],
  };
  assert.equal(computeLocationTax(withZeroRateShipTos).active, false);
  assert.deepEqual(
    computeConfirmationTotals(withZeroRateShipTos),
    computeConfirmationTotals(base),
  );
});

// ── Per-location tax math ────────────────────────────────────────────────────
test('single taxed location: tax = allocated merchandise × rate', () => {
  // One item, 100 units @ $10 = $1000, all going to a NJ location @ 6.625%.
  const conf = {
    items: [item(100, 10, [{ key: 'nj', qty: 100 }])],
    shipTos: [{ key: 'nj', label: 'Newark', state: 'NJ', taxRate: 6.625 }],
  };
  const tax = computeLocationTax(conf);
  assert.equal(tax.active, true);
  assert.equal(tax.lines.length, 1);
  assert.equal(round(tax.lines[0].subtotal), 1000);
  assert.equal(round(tax.total), 66.25);                  // 1000 × 6.625%
  assert.match(tax.lines[0].label, /Newark tax - 6\.625%/);

  const { grandTotal } = computeConfirmationTotals(conf);
  assert.equal(round(grandTotal), 1066.25);
});

test('proportional allocation: item revenue splits by qty share per location', () => {
  // 100 units @ $10 = $1000. 70 to NJ (6.625%), 30 to NY (8%).
  // NJ subtotal = 1000 × 70/100 = 700  -> tax 46.375
  // NY subtotal = 1000 × 30/100 = 300  -> tax 24.00
  const conf = {
    items: [item(100, 10, [{ key: 'nj', qty: 70 }, { key: 'ny', qty: 30 }])],
    shipTos: [
      { key: 'nj', label: 'NJ', state: 'NJ', taxRate: 6.625 },
      { key: 'ny', label: 'NY', state: 'NY', taxRate: 8 },
    ],
  };
  const tax = computeLocationTax(conf);
  const byKey = Object.fromEntries(tax.lines.map(l => [l.label.split(' ')[0], l]));
  assert.equal(round(byKey.NJ.subtotal), 700);
  assert.equal(round(byKey.NY.subtotal), 300);
  // 6.625% of 700 is 46.375 exactly (a sub-cent value); assert it precisely.
  assert.equal(byKey.NJ.value, 46.375);
  assert.equal(byKey.NY.value, 24);
  assert.equal(byKey.NJ.value + byKey.NY.value, 70.375);
  assert.equal(tax.total, 70.375);
});

test('proportional allocation across mixed sizes and multiple items', () => {
  // Item A: 60 @ $20 + 40 @ $30 = 1200 + 1200 = 2400, total qty 100.
  //   alloc 50 -> loc1, 50 -> loc2  => each gets 2400 × 50/100 = 1200
  // Item B: 20 @ $50 = 1000, total qty 20.
  //   alloc 20 -> loc1                => loc1 gets 1000, loc2 gets 0
  // loc1 subtotal = 1200 + 1000 = 2200 @ 6% -> 132
  // loc2 subtotal = 1200          @ 8% -> 96
  const conf = {
    items: [
      sizedItem(
        [{ label: 'M', qty: 60, unitPrice: 20 }, { label: 'L', qty: 40, unitPrice: 30 }],
        [{ key: 'loc1', qty: 50 }, { key: 'loc2', qty: 50 }],
      ),
      sizedItem(
        [{ label: 'OS', qty: 20, unitPrice: 50 }],
        [{ key: 'loc1', qty: 20 }],
      ),
    ],
    shipTos: [
      { key: 'loc1', label: 'One', taxRate: 6 },
      { key: 'loc2', label: 'Two', taxRate: 8 },
    ],
  };
  const tax = computeLocationTax(conf);
  const byLabel = Object.fromEntries(tax.lines.map(l => [l.label.split(' ')[0], l]));
  assert.equal(round(byLabel.One.subtotal), 2200);
  assert.equal(round(byLabel.Two.subtotal), 1200);
  assert.equal(round(byLabel.One.value), 132);
  assert.equal(round(byLabel.Two.value), 96);
  assert.equal(round(tax.total), 228);
});

// ── Grand total integration (tax sits on top of merchandise, after add-ons) ──
test('multi-location grand total = items + customLines + location tax', () => {
  // Items: 2000. CC fee 2.99% -> +59.80 (running 2059.80).
  // Location tax is on MERCHANDISE (2000), not the running total:
  //   60% NJ (6.625%) -> 1200 × 6.625% = 79.50
  //   40% NY (8%)     ->  800 × 8%      = 64.00
  //   total tax = 143.50
  // Grand total = 2059.80 + 143.50 = 2203.30
  const conf = {
    items: [item(100, 10, [{ key: 'nj', qty: 60 }, { key: 'ny', qty: 40 }]),
            item(50, 20, [{ key: 'nj', qty: 30 }, { key: 'ny', qty: 20 }])],
    customLines: [{ label: 'Credit card fee', amount: 2.99, isPercent: true }],
    shipTos: [
      { key: 'nj', label: 'NJ', taxRate: 6.625 },
      { key: 'ny', label: 'NY', taxRate: 8 },
    ],
  };
  const tax = computeLocationTax(conf);
  assert.equal(round(tax.total), 143.5);
  const { grandTotal } = computeConfirmationTotals(conf);
  assert.equal(round(grandTotal), 2203.3);
});

test('unallocated units contribute no tax (only allocated revenue is taxed)', () => {
  // 100 units @ $10 = 1000, but only 40 allocated to the taxed location.
  const conf = {
    items: [item(100, 10, [{ key: 'nj', qty: 40 }])],
    shipTos: [{ key: 'nj', label: 'NJ', taxRate: 6.625 }],
  };
  const tax = computeLocationTax(conf);
  assert.equal(round(tax.lines[0].subtotal), 400);
  assert.equal(round(tax.total), 26.5);              // 400 × 6.625%
});

// ── STATE_TAX_RATES map ──────────────────────────────────────────────────────
test('STATE_TAX_RATES covers the owner territory with expected rates', () => {
  assert.deepEqual(STATE_TAX_RATES, { NJ: 6.625, NY: 8, CT: 6.35, MA: 6.25, VT: 6, PA: 6 });
});

// Round to cents to keep float noise out of the assertions.
function round(n) { return Math.round(n * 100) / 100; }
