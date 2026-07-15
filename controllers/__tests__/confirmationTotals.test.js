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
  isTaxCustomLine,
  hasBakedPaymentFee,
  roundCents,
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
  // NJ subtotal = 1000 × 70/100 = 700  -> tax 46.375 -> rounded to cents = 46.38
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
  // Each tax line is a REAL cent amount (H4): 46.375 rounds half-up to 46.38.
  assert.equal(byKey.NJ.value, 46.38);
  assert.equal(byKey.NY.value, 24);
  // Total is the sum of the cent-rounded lines, so it reconciles to the lines
  // the client actually sees: 46.38 + 24 = 70.38.
  assert.equal(byKey.NJ.value + byKey.NY.value, 70.38);
  assert.equal(tax.total, 70.38);
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

// ── C3: double-tax guard (per-location tax XOR legacy tax customLine) ─────────
test('isTaxCustomLine: flag wins, else label /tax/i', () => {
  assert.equal(isTaxCustomLine({ label: 'NJ sales tax', amount: 6.625, isPercent: true }), true);
  assert.equal(isTaxCustomLine({ label: 'Sales Tax', amount: 50 }), true);
  assert.equal(isTaxCustomLine({ label: 'NY Tax - 8%', amount: 8, isPercent: true }), true);
  assert.equal(isTaxCustomLine({ label: 'Shipping reserve', amount: 25 }), false);
  assert.equal(isTaxCustomLine({ label: 'Credit card fee', amount: 2.99, isPercent: true }), false);
  // Explicit flag honored even when the label says nothing.
  assert.equal(isTaxCustomLine({ label: 'State', amount: 6, isPercent: true, isTax: true }), true);
  assert.equal(isTaxCustomLine(null), false);
});

test('SINGLE-LOCATION, NO shipTo tax: byte-identical totals (no regression)', () => {
  // The mandatory regression pin: a plain single-location confirmation with a
  // legacy "NJ tax" customLine and NO taxed shipTos must produce EXACTLY the
  // pre-change totals — the double-tax guard and cent-rounding are inert here.
  const conf = {
    items: [item(100, 10), item(50, 20)],            // 2000
    customLines: [{ label: 'NJ sales tax', amount: 6.625, isPercent: true }],
  };
  const { itemsSubtotal, grandTotal } = computeConfirmationTotals(conf);
  assert.equal(itemsSubtotal, 2000);
  assert.equal(grandTotal, 2132.5);                  // 2000 × 1.06625 — unchanged
});

test('per-location tax ACTIVE: a legacy tax customLine is dropped (taxed once)', () => {
  // Both a legacy "NJ sales tax" customLine AND a taxed shipTo are present (the
  // exact conflict the audit found). Per-location tax wins; the customLine must
  // NOT also apply. Items 1000, all to NJ @ 6.625% -> tax 66.25 -> grand 1066.25.
  // If the legacy 6.625% line ALSO applied, the total would balloon to ~1132.50.
  const conf = {
    items: [item(100, 10, [{ key: 'nj', qty: 100 }])],
    customLines: [{ label: 'NJ sales tax', amount: 6.625, isPercent: true }],
    shipTos: [{ key: 'nj', label: 'Newark', state: 'NJ', taxRate: 6.625 }],
  };
  const { grandTotal } = computeConfirmationTotals(conf);
  assert.equal(grandTotal, 1066.25);                 // taxed exactly once
});

test('per-location tax ACTIVE: NON-tax customLines still apply', () => {
  // A CC fee is not a tax line — per-location tax must not suppress it.
  // Items 1000; CC fee 2.99% on 1000 = 29.90 (running 1029.90); NJ tax on
  // MERCHANDISE 1000 @ 6.625% = 66.25. Grand = 1029.90 + 66.25 = 1096.15.
  const conf = {
    items: [item(100, 10, [{ key: 'nj', qty: 100 }])],
    customLines: [{ label: 'Credit card fee', amount: 2.99, isPercent: true }],
    shipTos: [{ key: 'nj', label: 'NJ', taxRate: 6.625 }],
  };
  const { grandTotal } = computeConfirmationTotals(conf);
  assert.equal(grandTotal, 1096.15);
});

test('no per-location tax: a legacy tax customLine STILL applies (back-comp)', () => {
  // With zero-rate shipTos (inactive per-location tax), the legacy line is the
  // only tax and must apply, exactly as before.
  const conf = {
    items: [item(100, 10, [{ key: 'a', qty: 100 }])],
    customLines: [{ label: 'NJ sales tax', amount: 6.625, isPercent: true }],
    shipTos: [{ key: 'a', label: 'HQ', state: 'NJ', taxRate: 0 }],
  };
  const { grandTotal } = computeConfirmationTotals(conf);
  assert.equal(grandTotal, 1066.25);                 // 1000 × 1.06625
});

// ── H5: over/under-allocation can't tax beyond the item's real revenue ───────
test('over-allocation is clamped: taxed base never exceeds item revenue', () => {
  // 100 units @ $10 = 1000, but 140 units "allocated" to NJ (bad data). The
  // taxable base must clamp to the item's full revenue (1000), not 1400.
  const conf = {
    items: [item(100, 10, [{ key: 'nj', qty: 140 }])],
    shipTos: [{ key: 'nj', label: 'NJ', taxRate: 6.625 }],
  };
  const tax = computeLocationTax(conf);
  assert.equal(round(tax.lines[0].subtotal), 1000);  // clamped to real revenue
  assert.equal(tax.total, 66.25);                     // 1000 × 6.625%, not 1400's
});

test('over-allocation across locations cannot tax more than 100% of merchandise', () => {
  // 100 @ $10 = 1000. Allocations sum to 150 (60 NJ + 90 NY) — over-allocated.
  // Each location's share clamps to ≤ its own ratio of itemQty; with 60/100 and
  // 90/100 -> NJ taxes 600, NY taxes 900 -> combined taxed base 1500 would be >
  // merchandise. The per-location clamp keeps EACH within [0,1] of the item; this
  // test pins that neither line exceeds the item revenue.
  const conf = {
    items: [item(100, 10, [{ key: 'nj', qty: 60 }, { key: 'ny', qty: 90 }])],
    shipTos: [
      { key: 'nj', label: 'NJ', taxRate: 10 },
      { key: 'ny', label: 'NY', taxRate: 10 },
    ],
  };
  const tax = computeLocationTax(conf);
  const byKey = Object.fromEntries(tax.lines.map(l => [l.label.split(' ')[0], l]));
  assert.ok(byKey.NJ.subtotal <= 1000, 'NJ taxed base within item revenue');
  assert.ok(byKey.NY.subtotal <= 1000, 'NY taxed base within item revenue');
});

test('negative allocation contributes no tax (clamped to 0)', () => {
  const conf = {
    items: [item(100, 10, [{ key: 'nj', qty: -50 }])],
    shipTos: [{ key: 'nj', label: 'NJ', taxRate: 6.625 }],
  };
  const tax = computeLocationTax(conf);
  assert.equal(round(tax.lines[0].subtotal), 0);
  assert.equal(tax.total, 0);
});

// ── H4: grand total snaps to cents ───────────────────────────────────────────
test('roundCents snaps half-up to two decimals', () => {
  assert.equal(roundCents(2132.5000000001), 2132.5);
  assert.equal(roundCents(46.375), 46.38);
  assert.equal(roundCents(1.005), 1.01);
  assert.equal(roundCents(0), 0);
});

test('grand total has no sub-cent drift', () => {
  // A unitPrice that produces a binary-imperfect subtotal: 3 @ 0.1 = 0.30000…04.
  const conf = { items: [item(3, 0.1)], customLines: [] };
  const { grandTotal } = computeConfirmationTotals(conf);
  assert.equal(grandTotal, 0.3);                      // snapped, not 0.30000000000000004
});

// ── STATE_TAX_RATES map ──────────────────────────────────────────────────────
test('STATE_TAX_RATES auto-prefills ONLY NJ (the only nexus) — no other state', () => {
  assert.deepEqual(STATE_TAX_RATES, { NJ: 6.625 });
});

// Round to cents to keep float noise out of the assertions.
function round(n) { return Math.round(n * 100) / 100; }

// ── Payment fee model (derived) + total units ────────────────────────────────
// The fee is charged EXACTLY once: a baked Card/ACH fee always applies to the
// total, and the PRESENCE of such a line is what HIDES the client's payment picker
// (hasBakedPaymentFee) — so it can never be both baked AND picked. Discounts / tax /
// shipping are not payment fees and never suppress the picker.
test('a baked card fee always applies to the total', () => {
  const conf = { items: [item(10, 20)], customLines: [{ label: 'Credit card fee', amount: 2.99, isPercent: true }] };
  assert.equal(computeConfirmationTotals(conf).grandTotal, 205.98);   // $200 + 2.99%
});

test('hasBakedPaymentFee: true for Card/ACH, false for discount/tax/shipping', () => {
  assert.equal(hasBakedPaymentFee({ customLines: [{ label: 'Credit card fee', amount: 2.99, isPercent: true }] }), true);
  assert.equal(hasBakedPaymentFee({ customLines: [{ label: 'ACH fee', amount: 1, isPercent: true }] }), true);
  assert.equal(hasBakedPaymentFee({ customLines: [{ label: 'Loyalty discount', amount: -50, isPercent: false }] }), false);
  assert.equal(hasBakedPaymentFee({ customLines: [{ label: 'Shipping reserve', amount: 15 }] }), false);
  assert.equal(hasBakedPaymentFee({ customLines: [{ label: 'NJ sales tax', amount: 6.625, isPercent: true, isTax: true }] }), false);
  assert.equal(hasBakedPaymentFee({ customLines: [] }), false);
});

test('a non-fee add-on line always applies to the total', () => {
  const conf = { items: [item(10, 20)], customLines: [{ label: 'Shipping reserve', amount: 15, isPercent: false }] };
  assert.equal(computeConfirmationTotals(conf).grandTotal, 215);
});

test('computeConfirmationTotals reports totalUnits across items', () => {
  const conf = { items: [item(10, 20), { sizes: [{ label: 'S', qty: 5, unitPrice: 20 }, { label: 'M', qty: 7, unitPrice: 20 }] }] };
  assert.equal(computeConfirmationTotals(conf).totalUnits, 22);
  assert.equal(computeConfirmationTotals({ items: [] }).totalUnits, 0);
});
