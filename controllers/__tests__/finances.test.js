// controllers/__tests__/finances.test.js
//
// Pure-logic checks for the reusable company finance rollup (no DB). Runs on
// Node's built-in test runner — no extra dev deps:
//
//   node --test controllers/__tests__/finances.test.js
//
// summarizeCompanyFinance / normalizeOrderNumber are exported from
// controllers/finances.js and take plain POJOs (the orders + ledger rows a
// caller already fetched), so they're testable without Mongo. The point of
// these tests is to PIN the revenue/COGS/profit/margin/outstanding definitions
// the CRM company page reuses, so they can't silently drift from /api/finances.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeCompanyFinance,
  normalizeOrderNumber,
  orderRevenueCost,
  pct,
  incomeContribution,
} = require('../finances');

// Ledger-row factories matching Transaction shape (amount is always positive;
// isCredit flips direction within the type bucket — same rule as the ledger).
const sale   = (amount, over = {}) => ({ type: 'income',  category: 'Customer Sales', amount, ...over });
const blank  = (amount, over = {}) => ({ type: 'expense', category: 'Blank COGS',     amount, ...over });
const printc = (amount, over = {}) => ({ type: 'expense', category: 'Printer COGS',   amount, ...over });
const order  = (over = {}) => ({ orderNumber: '0000001', totalValue: 0, paid: false, ...over });

// ── normalizeOrderNumber ─────────────────────────────────────────────────────
test('normalizeOrderNumber strips non-digits AND leading zeros (canonical key)', () => {
  // The C2 fix: leading zeros are dropped so "0000021" and "21" key the SAME.
  assert.equal(normalizeOrderNumber('#0000021'), '21');
  assert.equal(normalizeOrderNumber('0000021'),  '21');
  assert.equal(normalizeOrderNumber('21'),       '21');
  assert.equal(normalizeOrderNumber('PO-021'),   '21');
  assert.equal(normalizeOrderNumber('PO-21b'),   '21');
  // Interior/trailing zeros are preserved — only LEADING zeros are stripped.
  assert.equal(normalizeOrderNumber('0000210'),  '210');
  assert.equal(normalizeOrderNumber('1001'),     '1001');
  // All-zeros / empty / non-numeric -> '' (NOT collapsed into a shared bucket).
  assert.equal(normalizeOrderNumber('0000000'), '');
  assert.equal(normalizeOrderNumber('000'),     '');
  assert.equal(normalizeOrderNumber('0'),       '');
  assert.equal(normalizeOrderNumber(null),      '');
  assert.equal(normalizeOrderNumber(undefined), '');
  assert.equal(normalizeOrderNumber(''),        '');
  assert.equal(normalizeOrderNumber('#'),       '');
});

// ── M6: ONE per-order profit definition (byOrder == drill-in) ────────────────
test('orderRevenueCost: profit = Customer Sales − COGS; other rows excluded', () => {
  // This is the shared definition byOrder/byClient AND the drill-in reconcile to.
  const rows = [
    sale(1000),
    blank(300),
    printc(200),
    { type: 'expense', category: 'Software', amount: 99 },  // non-COGS → not in profit
    { type: 'income',  category: 'Refund',   amount: 50 },  // non-Customer-Sales → not in revenue
  ];
  const out = orderRevenueCost(rows);
  assert.equal(out.revenue, 1000);
  assert.equal(out.cost,    500);
  assert.equal(out.profit,  500);   // 1000 − 500, ignoring the Software + Refund rows
});

test('orderRevenueCost: credits net down both buckets (same signed() rule)', () => {
  const rows = [
    sale(1000), sale(100, { isCredit: true }),   // revenue 900
    blank(400), blank(50, { isCredit: true }),   // cost 350
  ];
  const out = orderRevenueCost(rows);
  assert.equal(out.revenue, 900);
  assert.equal(out.cost,    350);
  assert.equal(out.profit,  550);
});

test('orderRevenueCost matches summarizeCompanyFinance profit for the same rows', () => {
  // Pin that the two surfaces can never drift: same rows -> same profit.
  const rows = [sale(1234.56), blank(400), printc(123.45), { type: 'income', category: 'Refund', amount: 25 }];
  assert.equal(orderRevenueCost(rows).profit, summarizeCompanyFinance([], rows).profit);
});

// ── L8: a Refund is contra-revenue (reduces income, never inflates it) ───────
test('incomeContribution: Refund reduces income for BOTH plain and credit forms', () => {
  // The bug: a 'Refund' income row added to revenue. Now it nets down by its
  // magnitude, so it can never inflate income regardless of how it was booked.
  assert.equal(incomeContribution('Refund', 50),   -50);  // plain positive refund
  assert.equal(incomeContribution('Refund', -50),  -50);  // credit-form refund (signed −50)
  assert.equal(incomeContribution('Refund', 0),      0);
  // Other income counts as-is; Owner Contribution is equity (0 toward income).
  assert.equal(incomeContribution('Customer Sales', 1000), 1000);
  assert.equal(incomeContribution('Customer Sales', -100), -100); // a sales credit nets down
  assert.equal(incomeContribution('Owner Contribution', 5000), 0);
  assert.equal(incomeContribution('Other', 42), 42);
});

// ── M7: pct guard (no Infinity/NaN on a ~zero denominator) ───────────────────
test('pct guards a zero / sub-cent / non-finite denominator', () => {
  assert.equal(pct(500, 1000), 50);
  assert.equal(pct(50, 0),      0);     // exact zero
  assert.equal(pct(50, 0.004),  0);     // sub-cent base -> 0, not 1,250,000%
  assert.equal(pct(50, -0.004), 0);     // tiny negative base -> 0, not garbage
  assert.equal(pct(50, NaN),    0);
  assert.equal(pct(50, Infinity), 0);
  assert.equal(pct(-250, 1000), -25);   // negative numerator is fine
  assert.ok(Number.isFinite(pct(1, 0))); // never Infinity/NaN
});

// ── revenue / COGS / profit / margin ─────────────────────────────────────────
test('empty input is all zeroes', () => {
  assert.deepEqual(summarizeCompanyFinance([], []), {
    revenue: 0, cogs: 0, profit: 0, margin: 0, outstanding: 0, orderCount: 0, paidCount: 0,
  });
  assert.deepEqual(summarizeCompanyFinance(undefined, undefined), {
    revenue: 0, cogs: 0, profit: 0, margin: 0, outstanding: 0, orderCount: 0, paidCount: 0,
  });
});

test('revenue counts only income/Customer Sales; COGS only expense/COGS categories', () => {
  const txns = [
    sale(1000),
    blank(300),
    printc(200),
    { type: 'expense', category: 'Software', amount: 99 },   // not a COGS category → ignored
    { type: 'income',  category: 'Refund',   amount: 50 },   // income but not Customer Sales → ignored
  ];
  const out = summarizeCompanyFinance([], txns);
  assert.equal(out.revenue, 1000);
  assert.equal(out.cogs,    500);     // 300 + 200
  assert.equal(out.profit,  500);     // 1000 - 500
  assert.equal(out.margin,  50);      // 500 / 1000 * 100
});

test('credits net DOWN their own bucket (same rule as the ledger)', () => {
  const txns = [
    sale(1000),
    sale(100, { isCredit: true }),    // customer refund → revenue 900
    blank(400),
    blank(50, { isCredit: true }),    // supplier credit → COGS 350
  ];
  const out = summarizeCompanyFinance([], txns);
  assert.equal(out.revenue, 900);
  assert.equal(out.cogs,    350);
  assert.equal(out.profit,  550);
});

test('margin is 0 when there is no revenue (no divide-by-zero)', () => {
  const out = summarizeCompanyFinance([], [blank(250)]);
  assert.equal(out.revenue, 0);
  assert.equal(out.cogs,    250);
  assert.equal(out.profit,  -250);    // pure cost → negative profit
  assert.equal(out.margin,  0);
});

test('money rounds to cents (round2, no float drift)', () => {
  // 333.33 revenue, 111.11 cost → profit 222.22; margin 222.22/333.33*100 = 66.6664… → 66.67
  const out = summarizeCompanyFinance([], [sale(333.33), blank(111.11)]);
  assert.equal(out.revenue, 333.33);
  assert.equal(out.cogs,    111.11);
  assert.equal(out.profit,  222.22);
  assert.equal(out.margin,  66.67);
});

// ── outstanding / order tallies (from Orders, not the ledger) ────────────────
test('outstanding = totalValue of UNPAID orders; paid orders excluded', () => {
  const orders = [
    order({ orderNumber: '1', paid: true,  totalValue: 500 }),  // paid → not outstanding
    order({ orderNumber: '2', paid: false, totalValue: 800 }),  // unpaid → outstanding
    order({ orderNumber: '3', paid: false, totalValue: 200 }),  // unpaid → outstanding
  ];
  const out = summarizeCompanyFinance(orders, []);
  assert.equal(out.outstanding, 1000);  // 800 + 200
  assert.equal(out.orderCount,  3);
  assert.equal(out.paidCount,   1);
});

test('outstanding is independent of revenue (ledger vs invoiced are different lenses)', () => {
  // An order can be fully paid in the ledger sense yet have revenue rows, and an
  // unpaid order contributes to outstanding regardless of any Tx.
  const orders = [order({ orderNumber: '7', paid: false, totalValue: 1500 })];
  const txns   = [sale(1500), blank(600)];
  const out = summarizeCompanyFinance(orders, txns);
  assert.equal(out.revenue,     1500);
  assert.equal(out.cogs,        600);
  assert.equal(out.profit,      900);
  assert.equal(out.outstanding, 1500);  // unpaid invoice still owed
  assert.equal(out.paidCount,   0);
});

test('non-numeric totalValue is treated as 0 for outstanding', () => {
  const orders = [
    order({ paid: false, totalValue: undefined }),
    order({ paid: false, totalValue: null }),
    order({ paid: false, totalValue: '300' }),  // numeric string still counts (num())
  ];
  const out = summarizeCompanyFinance(orders, []);
  assert.equal(out.outstanding, 300);
  assert.equal(out.orderCount,  3);
});
