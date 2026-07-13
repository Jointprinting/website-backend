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
