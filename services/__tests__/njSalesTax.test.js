// services/__tests__/njSalesTax.test.js
//   node --test services/__tests__/njSalesTax.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { activeFiling, dueDateFor, QUARTERS, orderSaleDate, njTaxForOrder, grossReceiptsForOrder } = require('../njSalesTax');

test('the Jul-20 filing (Q2) is active in mid-July', () => {
  const f = activeFiling(new Date(2026, 6, 11)); // Jul 11, 2026
  assert.ok(f, 'a filing is active');
  assert.equal(f.label, 'Q2 (Apr–Jun)');
  assert.equal(f.periodStart.getMonth(), 3);   // April
  assert.equal(f.periodEnd.getMonth(), 6);      // exclusive July 1
  assert.equal(f.dueDate.getMonth(), 6);        // July
  assert.equal(f.dueDate.getDate(), 20);
  assert.ok(f.daysUntilDue > 0 && f.daysUntilDue <= 14);
});

test('the reminder is dormant well outside every window (e.g. mid-Feb)', () => {
  assert.equal(activeFiling(new Date(2026, 1, 15)), null);
});

test('each quarter opens its reminder ~2 weeks before its 20th', () => {
  // Jan 6 → Q4 of the PRIOR year (due Jan 20).
  const jan = activeFiling(new Date(2026, 0, 8));
  assert.equal(jan.label, 'Q4 (Oct–Dec)');
  assert.equal(jan.salesYear, 2025);
  assert.equal(jan.dueDate.getFullYear(), 2026);
  // Apr 15 → Q1 (due Apr 20); Oct 12 → Q3 (due Oct 20).
  assert.equal(activeFiling(new Date(2026, 3, 15)).label, 'Q1 (Jan–Mar)');
  assert.equal(activeFiling(new Date(2026, 9, 12)).label, 'Q3 (Jul–Sep)');
});

test('Q4 due date rolls into the following January', () => {
  const due = dueDateFor(QUARTERS[3], 2026);
  assert.equal(due.getFullYear(), 2027);
  assert.equal(due.getMonth(), 0);
  assert.equal(due.getDate(), 20);
});

test('njTaxForOrder totals only the NJ ship-to location tax lines', () => {
  const order = {
    confirmation: {
      items: [{ sizes: [{ qty: 100, unitPrice: 10 }], allocations: [{ key: 'nj', qty: 60 }, { key: 'ny', qty: 40 }] }],
      shipTos: [
        { key: 'nj', state: 'NJ', taxRate: 6.625, label: 'Trenton' },
        { key: 'ny', state: 'NY', taxRate: 8, label: 'NYC' },
      ],
    },
  };
  const { taxable, tax } = njTaxForOrder(order);
  // NJ base = 60% of $1000 = $600; tax = 600 * 6.625% = 39.75. NY excluded.
  assert.equal(taxable, 600);
  assert.equal(tax, 39.75);
});

test('a legacy single NJ tax custom line counts only when the order shipped to NJ', () => {
  const base = {
    shipToState: 'NJ',
    confirmation: {
      items: [{ sizes: [{ qty: 50, unitPrice: 20 }] }],   // $1000 subtotal
      customLines: [{ label: 'NJ Sales Tax', amount: 6.625, isPercent: true }],
    },
  };
  assert.equal(njTaxForOrder(base).tax, 66.25);
  // Same order shipped to PA → the NJ line doesn't apply.
  assert.equal(njTaxForOrder({ ...base, shipToState: 'PA' }).tax, 0);
});

test('grossReceiptsForOrder excludes per-location tax (ST-50 line 1)', () => {
  const order = {
    confirmation: {
      items: [{ sizes: [{ qty: 100, unitPrice: 10 }], allocations: [{ key: 'nj', qty: 60 }, { key: 'ny', qty: 40 }] }],
      shipTos: [
        { key: 'nj', state: 'NJ', taxRate: 6.625, label: 'Trenton' },
        { key: 'ny', state: 'NY', taxRate: 8, label: 'NYC' },
      ],
    },
  };
  // $1000 of goods; NJ tax 39.75 + NY tax 32 ride the grand total but are NOT receipts.
  assert.equal(grossReceiptsForOrder(order), 1000);
});

test('grossReceiptsForOrder excludes a legacy percent tax custom line but keeps real charges', () => {
  const order = {
    shipToState: 'NJ',
    confirmation: {
      items: [{ sizes: [{ qty: 50, unitPrice: 20 }] }],   // $1000 subtotal
      customLines: [
        { label: 'Shipping', amount: 40 },
        { label: 'NJ Sales Tax', amount: 6.625, isPercent: true },
      ],
    },
  };
  // Receipts = $1000 goods + $40 shipping; the 6.625% tax line drops out.
  const gross = grossReceiptsForOrder(order);
  assert.ok(Math.abs(gross - 1040) < 0.02, `gross ${gross} ≈ 1040`);
});

test('grossReceiptsForOrder is 0 with no confirmation', () => {
  assert.equal(grossReceiptsForOrder({}), 0);
});

test('orderSaleDate prefers orderDate, then paid date, then createdAt', () => {
  assert.equal(+orderSaleDate({ orderDate: '2026-05-10', createdAt: '2026-05-01' }), +new Date('2026-05-10'));
  assert.equal(+orderSaleDate({ createdAt: '2026-05-01' }), +new Date('2026-05-01'));
  assert.equal(orderSaleDate({}), null);
});

// ---------------------------------------------------------------------------
// THE QUARTER BOUNDARY.
//
// This file's header claimed it reasoned in ET while `quarterOf` called
// `date.getMonth()` and the period range used `new Date(y, m, d)` — both of which
// resolve in the SERVER's zone. Production runs UTC, which is ahead of Eastern.
//
// So a sale rung up at 9pm ET on the last day of a quarter is already the next
// day in UTC, and filed under the WRONG QUARTER. That is a misstated state
// return, at the one moment of the year the shop is most likely to be selling.
//
// These run under TZ=UTC (as production does) — that's the whole point.
// ---------------------------------------------------------------------------
const { quarterOf: _quarterOf, activeFiling: _activeFiling } = require('../njSalesTax');

test('a sale at 9pm ET on March 31 files under Q1, not Q2', () => {
  // 2026-03-31 21:00 ET (EDT, −4) === 2026-04-01T01:00Z
  const sale = new Date('2026-04-01T01:00:00Z');
  assert.equal(sale.getUTCMonth(), 3, 'sanity: this IS April to a UTC server');
  assert.equal(_quarterOf(sale).label, 'Q1 (Jan–Mar)');
});

test('a sale at 7pm ET on December 31 files under Q4 of that year, not Q1 of the next', () => {
  // 2026-12-31 19:00 ET (EST, −5) === 2027-01-01T00:00Z
  const sale = new Date('2027-01-01T00:00:00Z');
  assert.equal(sale.getUTCFullYear(), 2027, 'sanity: this IS next year to a UTC server');
  assert.equal(_quarterOf(sale).label, 'Q4 (Oct–Dec)');
});

test('a sale just after ET midnight on April 1 correctly files under Q2', () => {
  // The other side of the same boundary — the fix must not overcorrect.
  const sale = new Date('2026-04-01T04:30:00Z');   // 12:30am ET Apr 1
  assert.equal(_quarterOf(sale).label, 'Q2 (Apr–Jun)');
});

test('the period window starts and ends at ET midnight, so a 9pm-ET sale is inside it', () => {
  // Apr 10 2026 — inside Q1's reminder window (due Apr 20).
  const filing = _activeFiling(new Date('2026-04-10T12:00:00Z'));
  assert.ok(filing, 'Q1 should be in its reminder window on Apr 10');
  assert.equal(filing.label, 'Q1 (Jan–Mar)');
  // Q1 runs [Jan 1 00:00 ET, Apr 1 00:00 ET). A 9pm-ET Mar 31 sale must be inside.
  const lateSale = new Date('2026-04-01T01:00:00Z');
  assert.ok(lateSale >= filing.periodStart && lateSale < filing.periodEnd,
    'the last evening of the quarter must fall inside the quarter being filed');
  assert.equal(filing.periodStart.toISOString(), '2026-01-01T05:00:00.000Z', 'Jan 1 ET midnight (EST)');
  assert.equal(filing.periodEnd.toISOString(), '2026-04-01T04:00:00.000Z', 'Apr 1 ET midnight (EDT)');
});

test('Q4 rolls its exclusive end into January of the FOLLOWING year', () => {
  // Jan 15 2027 — inside Q4-2026's reminder window (due Jan 20 2027).
  const filing = _activeFiling(new Date('2027-01-15T12:00:00Z'));
  assert.ok(filing);
  assert.equal(filing.label, 'Q4 (Oct–Dec)');
  assert.equal(filing.salesYear, 2026);
  assert.equal(filing.periodEnd.toISOString(), '2027-01-01T05:00:00.000Z');
  assert.equal(filing.dueDate.toISOString(), '2027-01-20T05:00:00.000Z', 'due Jan 20 ET, not UTC');
});
