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
  orderActualCost,
  actualCostByOrder,
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

// ── ACTUAL cost from receipts (the new source of truth for an order) ─────────
test('orderActualCost: cost = signed COGS expenses; non-COGS + income excluded', () => {
  // The ACTUAL an order/project shows = Σ of its linked COGS expense receipts,
  // same `cost` definition as orderRevenueCost (so they reconcile to the cent).
  const rows = [
    sale(1000),                                              // income → not a cost
    blank(300, { receiptUrl: 'https://r2/a.pdf' }),
    printc(200, { receiptUrl: 'https://r2/b.jpg' }),
    { type: 'expense', category: 'Software', amount: 99 },   // non-COGS → excluded
  ];
  const a = orderActualCost(rows);
  assert.equal(a.actualCost, 500);     // 300 + 200, ignoring sale + Software
  assert.equal(a.cogsLines, 2);
  assert.equal(a.receiptCount, 2);     // both COGS rows carry a receipt file
  assert.equal(a.hasReceipts, true);
  // The actual matches the cost half of the shared per-order profit definition.
  assert.equal(a.actualCost, orderRevenueCost(rows).cost);
});

test('orderActualCost: a supplier credit nets the actual cost DOWN (signed rule)', () => {
  const rows = [
    blank(400, { receiptUrl: 'r' }),
    blank(50, { isCredit: true }),     // supplier credit → cost 350, no receipt file
  ];
  const a = orderActualCost(rows);
  assert.equal(a.actualCost, 350);
  assert.equal(a.cogsLines, 2);
  assert.equal(a.receiptCount, 1);     // only the charge carries a receipt
});

test('orderActualCost: no COGS rows → zero cost and hasReceipts false (UI flags missing)', () => {
  const a = orderActualCost([sale(1000), { type: 'expense', category: 'Software', amount: 12 }]);
  assert.equal(a.actualCost, 0);
  assert.equal(a.receiptCount, 0);
  assert.equal(a.hasReceipts, false);  // → the order view falls back to the estimate
  assert.deepEqual(orderActualCost([]), { actualCost: 0, cogsLines: 0, receiptCount: 0, hasReceipts: false });
});

test('actualCostByOrder: groups by CANONICAL order # (leading-zero variants merge)', () => {
  // The C2 fix carried to actuals: "0000021" and "21" are the SAME order, so a
  // receipt booked under either variant rolls into one actual-cost bucket.
  const rows = [
    blank(300, { orderNumber: '0000021', receiptUrl: 'r1' }),
    printc(200, { orderNumber: '21',     receiptUrl: 'r2' }),   // same order as 0000021
    blank(75,  { orderNumber: '022' }),                          // a DIFFERENT order (22)
    { type: 'expense', category: 'Software', amount: 99, orderNumber: '21' }, // non-COGS → ignored
    blank(40,  { orderNumber: '' }),                             // no order # → dropped
  ];
  const map = actualCostByOrder(rows);
  assert.deepEqual(Object.keys(map).sort(), ['21', '22']);
  assert.equal(map['21'].actualCost, 500);   // 300 + 200 across both leading-zero variants
  assert.equal(map['21'].receiptCount, 2);
  assert.equal(map['22'].actualCost, 75);
  assert.equal(map['22'].hasReceipts, false);
});

// ── ACTUAL vs ESTIMATED cogs on the company rollup ───────────────────────────
test('summarizeCompanyFinance: cogs is ACTUAL (receipts); estimatedCogs sums Order.cogs', () => {
  // Headline cost + profit come from the receipts (actual). The estimate is shown
  // ALONGSIDE (from the confirmation/quote stored on each Order), never replacing.
  const orders = [
    order({ orderNumber: '1', paid: true, totalValue: 1000, cogs: 450 }),   // estimate 450
    order({ orderNumber: '2', paid: true, totalValue: 0,    cogs: 50 }),
  ];
  const txns = [sale(1000), blank(300, { receiptUrl: 'r' }), printc(200)];  // actual cost 500
  const out = summarizeCompanyFinance(orders, txns);
  assert.equal(out.revenue,       1000);
  assert.equal(out.cogs,          500);   // ACTUAL from receipts (300 + 200)
  assert.equal(out.estimatedCogs, 500);   // ESTIMATE from Orders (450 + 50)
  assert.equal(out.profit,        500);   // revenue − ACTUAL cost
  assert.equal(out.receiptCount,  1);     // one COGS row carried a receipt file
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

// ── Owner take-home vs left-in-business (additive cash lens over profit) ──────
// The /api/finances summary computes, on top of the unchanged draw-EXCLUDED net:
//   takeHome       = ownerDraw                (cash the owner paid themselves)
//   leftInBusiness = net − ownerDraw          (profit retained after that draw)
// Profit/net are NOT redefined (a draw is a distribution of earned profit, not a
// cost — correct for an LLC/sole-prop taxed on profit). These tests pin the math.
const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
const takeHomeView = (net, ownerDraw) => ({
  net: round2(net),
  takeHome: round2(ownerDraw),
  leftInBusiness: round2(net - ownerDraw),
});

test('take-home view: takeHome = draw; leftInBusiness = net − draw (profit unchanged)', () => {
  // Earned $10k, took home $4k → $6k left in the business.
  assert.deepEqual(takeHomeView(10000, 4000), { net: 10000, takeHome: 4000, leftInBusiness: 6000 });
  // No draw → nothing taken home, all profit retained.
  assert.deepEqual(takeHomeView(10000, 0), { net: 10000, takeHome: 0, leftInBusiness: 10000 });
});

test('take-home view: drawing MORE than earned → negative left-in-business (a real signal)', () => {
  // Earned $5k but drew $8k (into prior cash) → −$3k retained this period. The
  // draw never made profit negative — profit stays $5k — but the owner sees the
  // cash reality.
  const v = takeHomeView(5000, 8000);
  assert.equal(v.net, 5000);            // profit unchanged by the draw
  assert.equal(v.takeHome, 8000);
  assert.equal(v.leftInBusiness, -3000);
});

test('take-home view: the three figures reconcile (net = leftInBusiness + takeHome)', () => {
  for (const [net, draw] of [[10000, 4000], [5000, 8000], [1234.56, 1000], [0, 0]]) {
    const v = takeHomeView(net, draw);
    assert.equal(round2(v.leftInBusiness + v.takeHome), round2(net));
  }
});

// ── revenue / COGS / profit / margin ─────────────────────────────────────────
test('empty input is all zeroes', () => {
  assert.deepEqual(summarizeCompanyFinance([], []), {
    revenue: 0, cogs: 0, estimatedCogs: 0, profit: 0, margin: 0, outstanding: 0, orderCount: 0, paidCount: 0, receiptCount: 0,
  });
  assert.deepEqual(summarizeCompanyFinance(undefined, undefined), {
    revenue: 0, cogs: 0, estimatedCogs: 0, profit: 0, margin: 0, outstanding: 0, orderCount: 0, paidCount: 0, receiptCount: 0,
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
