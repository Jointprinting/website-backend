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
  companyKeyByOrderNumber,
  orderRevenueCost,
  orderActualCost,
  actualCostByOrder,
  paymentGapsForOrders,
  pct,
  incomeContribution,
  orderRevenueContribution,
  processingFeeRate,
  computeProcessingFee,
  buildProcessingFeeDoc,
  inferRowType,
} = require('../finances');
const Transaction = require('../../models/Transaction');

// Ledger-row factories matching Transaction shape (amount is always positive;
// isCredit flips direction within the type bucket — same rule as the ledger).
const sale   = (amount, over = {}) => ({ type: 'income',  category: 'Client Sales', amount, ...over });
const blank  = (amount, over = {}) => ({ type: 'expense', category: 'Blank COGS',     amount, ...over });
const printc = (amount, over = {}) => ({ type: 'expense', category: 'Printer COGS',   amount, ...over });
const refund = (amount, over = {}) => ({ type: 'income',  category: 'Refund',         amount, ...over });
const procFee = (amount, over = {}) => ({ type: 'expense', category: 'Processing Fee', amount, ...over });
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
test('orderRevenueCost: profit = Client Sales − COGS; non-COGS/non-revenue rows excluded', () => {
  // This is the shared definition byOrder/byClient AND the drill-in reconcile to.
  // A non-COGS expense (Software) and a non-revenue income (Other) are both OUT;
  // a 'Refund' income row is now contra-revenue (Phase 2b — see the refund-parity
  // tests below), so it's covered there, not here.
  const rows = [
    sale(1000),
    blank(300),
    printc(200),
    { type: 'expense', category: 'Software', amount: 99 },  // non-COGS → not in profit
    { type: 'income',  category: 'Other',    amount: 50 },  // non-Customer-Sales income → not revenue
  ];
  const out = orderRevenueCost(rows);
  assert.equal(out.revenue, 1000);
  assert.equal(out.cost,    500);
  assert.equal(out.profit,  500);   // 1000 − 500, ignoring the Software + Other rows
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
  assert.equal(incomeContribution('Client Sales', 1000), 1000);
  assert.equal(incomeContribution('Client Sales', -100), -100); // a sales credit nets down
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

test('revenue counts income/Client Sales (+ Refund contra); COGS only expense/COGS categories', () => {
  const txns = [
    sale(1000),
    blank(300),
    printc(200),
    { type: 'expense', category: 'Software', amount: 99 },   // not a COGS category → ignored
    { type: 'income',  category: 'Other',    amount: 50 },   // income but not revenue → ignored
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

// ════════════════════════════════════════════════════════════════════════════
// PHASE 2b — refund-match unification (the #1 "numbers feel wrong" bug)
// ════════════════════════════════════════════════════════════════════════════
//
// The bug: a customer refund booked as category 'Refund' reduced the HEADLINE P&L
// (incomeContribution → −|amount|) but was DROPPED from byOrder/byClient/
// summarizeCompanyFinance/paymentGaps (which counted revenue strictly as
// income·'Client Sales'). So the refunded order kept full profit while the
// top-line fell — they never reconciled. orderRevenueContribution is now the ONE
// rule both sides use, so a refund nets the SAME order/client down by the SAME
// amount as the headline. These tests pin that AND the safety guarantee: a normal
// (non-refund) order's revenue/profit is byte-for-byte unchanged.

test('orderRevenueContribution: the single per-order revenue rule (matches headline)', () => {
  // Client Sales counts as-is; a Customer-Sales credit nets down; a 'Refund' row
  // is always contra (−|amount|, plain OR credit form); other income is NOT revenue.
  assert.equal(orderRevenueContribution(sale(1000)), 1000);
  assert.equal(orderRevenueContribution(sale(100, { isCredit: true })), -100);
  assert.equal(orderRevenueContribution(refund(50)), -50);                 // plain refund
  assert.equal(orderRevenueContribution(refund(50, { isCredit: true })), -50); // credit-form refund
  assert.equal(orderRevenueContribution({ type: 'income', category: 'Other', amount: 42 }), 0);
  assert.equal(orderRevenueContribution({ type: 'income', category: 'Owner Contribution', amount: 5000 }), 0);
  assert.equal(orderRevenueContribution(blank(300)), 0);                   // an expense isn't revenue
  assert.equal(orderRevenueContribution(null), 0);
  // For Client Sales / Refund it equals the headline's incomeContribution on the
  // signed amount — so per-order revenue and the P&L headline cannot drift.
  assert.equal(orderRevenueContribution(sale(1000)),  incomeContribution('Client Sales', 1000));
  assert.equal(orderRevenueContribution(refund(50)),  incomeContribution('Refund', 50));
});

test('SAFETY: a normal (no-refund) order is unchanged by the unification', () => {
  // The whole point — a normal order with only Client Sales + COGS reads exactly
  // as before. Revenue = sale, cost = COGS, profit = revenue − cost. Nothing moved.
  const rows = [sale(2000), blank(600), printc(400)];
  const out = orderRevenueCost(rows);
  assert.equal(out.revenue, 2000);
  assert.equal(out.cost,    1000);
  assert.equal(out.profit,  1000);
  // And it equals the company rollup profit for the same rows (no drift).
  assert.equal(out.profit, summarizeCompanyFinance([], rows).profit);
});

test('REFUND PARITY: a partial refund reduces order profit AND headline by the SAME amount', () => {
  // The core reconciliation proof. Same order: $1000 sale, $400 COGS, then a $150
  // partial refund booked as category 'Refund'. The refund must reduce BOTH the
  // order's profit and the headline income by exactly $150 — and they must match.
  const base   = [sale(1000), blank(400)];
  const withRf = [sale(1000), blank(400), refund(150)];

  // ── per-order (byOrder / drill-in / company rollup all share orderRevenueCost) ──
  const orderBase = orderRevenueCost(base).profit;     // 1000 − 400 = 600
  const orderRf   = orderRevenueCost(withRf).profit;   // (1000 − 150) − 400 = 450
  assert.equal(orderBase, 600);
  assert.equal(orderRf,   450);
  assert.equal(orderBase - orderRf, 150);              // order profit dropped by the refund

  // ── headline (the P&L sums incomeContribution per income category) ──
  const headlineIncome = (rows) => rows
    .filter((t) => t.type === 'income')
    .reduce((s, t) => s + incomeContribution(t.category, t.isCredit ? -t.amount : t.amount), 0);
  const hlBase = headlineIncome(base);                 // 1000
  const hlRf   = headlineIncome(withRf);               // 1000 − 150 = 850
  assert.equal(hlBase - hlRf, 150);                    // headline income dropped by the refund

  // SAME amount on both sides — the reconciliation the owner was missing.
  assert.equal(orderBase - orderRf, hlBase - hlRf);

  // summarizeCompanyFinance agrees (it's the CRM company page's number).
  assert.equal(summarizeCompanyFinance([], withRf).revenue, 850);
  assert.equal(summarizeCompanyFinance([], withRf).profit,  450);
});

test('REFUND PARITY: a Customer-Sales credit form gives the identical result', () => {
  // Booking the refund the OTHER consistent way (Client Sales + isCredit) must
  // land on the same numbers as the 'Refund'-category form.
  const viaRefundCat = orderRevenueCost([sale(1000), blank(400), refund(150)]);
  const viaCredit    = orderRevenueCost([sale(1000), blank(400), sale(150, { isCredit: true })]);
  assert.deepEqual(viaCredit, viaRefundCat);
  assert.equal(viaCredit.revenue, 850);
  assert.equal(viaCredit.profit,  450);
});

test('REFUND PARITY: paymentGaps "collected" nets the refund down too', () => {
  // collected must use the same contra rule, so a refunded order's collected matches
  // its revenue (otherwise the gap report would over-state what was collected).
  const orders = [order({ orderNumber: '21', totalValue: 1000, paid: false })];
  const txns = [
    sale(1000,  { orderNumber: '21' }),
    refund(150, { orderNumber: '21' }),
    blank(400,  { orderNumber: '21' }),
  ];
  const out = paymentGapsForOrders(orders, txns);
  const row = out.orders.find((r) => r.orderNumber === '21');
  assert.ok(row, 'order 21 should appear (billed 1000 > collected 850)');
  assert.equal(row.collected, 850);                    // 1000 − 150 refund
  assert.equal(row.outstanding, 150);                  // billed 1000 − collected 850
});

test('DEDUPE + cancelled: a duplicate order # is counted once; cancelled never owed', () => {
  // The same invoice present twice (an import/entry dupe) must not be "owed" twice,
  // and a cancelled order is never owed. This is the inflated-"money owed" bug.
  const orders = [
    order({ orderNumber: '1021', totalValue: 8321.39, paid: false }),
    order({ orderNumber: '1021', totalValue: 8321.39, paid: false }),  // exact duplicate record
    order({ orderNumber: '99',   totalValue: 500,     paid: false, status: 'cancelled' }),
  ];
  const out = paymentGapsForOrders(orders, []);
  assert.equal(out.orders.filter((r) => r.orderNumber === '1021').length, 1, 'duplicate order # appears once');
  assert.equal(out.orders.find((r) => r.orderNumber === '99'), undefined, 'cancelled order never owed');
  assert.equal(out.totals.billedNotCollected, 8321.39);  // counted once, not 16,642.78
});

// ════════════════════════════════════════════════════════════════════════════
// PHASE 2b — processing fee (CC 2.99% / ACH 1% / none), auto-booked on the order
// ════════════════════════════════════════════════════════════════════════════

test('processingFeeRate: CC/ACH/none defaults + owner override + clamp', () => {
  assert.equal(processingFeeRate('cc'),   0.0299);
  assert.equal(processingFeeRate('CC'),   0.0299);     // case-insensitive
  assert.equal(processingFeeRate('ach'),  0.01);
  assert.equal(processingFeeRate('none'), 0);
  assert.equal(processingFeeRate(''),     0);
  assert.equal(processingFeeRate(undefined), 0);
  assert.equal(processingFeeRate('weird'), 0);         // unknown method → no fee
  // Owner override (a fraction) overrides the RATE for a chargeable method (cc/ach).
  assert.equal(processingFeeRate('cc', 0.025), 0.025);
  assert.equal(processingFeeRate('ach', 0.015), 0.015);
  // …but 'none' means NO fee even with a (stale) override — the method is the on/off
  // switch, so a waived fee can't be resurrected by a leftover rate.
  assert.equal(processingFeeRate('none', 0.03), 0);
  // A bad/over-1 override can't book a fee bigger than the payment.
  assert.equal(processingFeeRate('cc', 5), 0.9999);
  assert.equal(processingFeeRate('cc', -1), 0);
  assert.equal(processingFeeRate('cc', 'abc'), 0);
  // Defaults live on the model (single source of truth).
  assert.equal(processingFeeRate('cc'), Transaction.PROCESSING_FEE_RATES.cc);
});

test('computeProcessingFee: amount × rate, rounded, only on a real client payment', () => {
  // $5600 CC payment → 2.99% = $167.44 (matches the owner's real ledger note).
  assert.equal(computeProcessingFee(sale(5600), 'cc'), 167.44);
  assert.equal(computeProcessingFee(sale(1000), 'ach'), 10);
  assert.equal(computeProcessingFee(sale(1000), 'none'), 0);
  assert.equal(computeProcessingFee(sale(1000), 'cc', 0.02), 20);   // override
  // NOT a fee on: a refund/credit, an expense, a non-sale income, or a zero amount.
  assert.equal(computeProcessingFee(sale(1000, { isCredit: true }), 'cc'), 0);
  assert.equal(computeProcessingFee(refund(1000), 'cc'), 0);
  assert.equal(computeProcessingFee(blank(1000), 'cc'), 0);
  assert.equal(computeProcessingFee({ type: 'income', category: 'Other', amount: 1000 }, 'cc'), 0);
  assert.equal(computeProcessingFee(sale(0), 'cc'), 0);
  assert.equal(computeProcessingFee(null, 'cc'), 0);
});

test('OVERRIDE PERSISTENCE: a stored override re-rates correctly; null falls back to default', () => {
  // The edit-re-rate bug: syncProcessingFee re-rates from the SAVED row's method +
  // feeRateOverride. So an edit that doesn't resend the rate must still use the
  // owner's stored override, and a null override (never set) uses the CC default.
  const paidCustom = sale(1000, { _id: 'P', paymentMethod: 'cc', feeRateOverride: 0.02 });
  // This mirrors what update() passes: (t, t.paymentMethod, t.feeRateOverride).
  assert.equal(computeProcessingFee(paidCustom, paidCustom.paymentMethod, paidCustom.feeRateOverride), 20);
  assert.equal(buildProcessingFeeDoc(paidCustom, paidCustom.paymentMethod, paidCustom.feeRateOverride).amount, 20);
  // No override stored (null) → CC default 2.99%.
  const paidDefault = sale(1000, { _id: 'P', paymentMethod: 'cc', feeRateOverride: null });
  assert.equal(computeProcessingFee(paidDefault, paidDefault.paymentMethod, paidDefault.feeRateOverride), 29.9);
  // Method switched to none on the saved row → no fee regardless of a stale override.
  const paidNone = sale(1000, { _id: 'P', paymentMethod: 'none', feeRateOverride: 0.02 });
  assert.equal(buildProcessingFeeDoc(paidNone, paidNone.paymentMethod, paidNone.feeRateOverride), null);
});

test('buildProcessingFeeDoc: a linked COGS expense on the SAME order (or null)', () => {
  const payment = sale(5600, { _id: 'PAY1', orderNumber: '129', party: 'Stadium Gardens', date: new Date('2025-03-01') });
  const doc = buildProcessingFeeDoc(payment, 'cc');
  assert.ok(doc);
  assert.equal(doc.type, 'expense');
  assert.equal(doc.category, 'Processing Fee');         // a COGS category → reduces order profit
  assert.equal(doc.amount, 167.44);
  assert.equal(doc.orderNumber, '129');                 // SAME order as the payment
  assert.equal(doc.party, 'Stadium Gardens');
  assert.equal(doc.isCredit, false);
  assert.equal(doc.feeForTxn, 'PAY1');                  // back-link → idempotent
  assert.equal(doc.source, 'fee:auto');
  assert.equal(doc.date, payment.date);
  // No method / none / a non-payment → no doc at all.
  assert.equal(buildProcessingFeeDoc(payment, 'none'), null);
  assert.equal(buildProcessingFeeDoc(payment, ''), null);
  assert.equal(buildProcessingFeeDoc(sale(1000, { _id: 'X' }), 'weird'), null);
});

test('Processing Fee is in COGS_CATEGORIES → it reduces the order profit', () => {
  // Front-to-back: a $5600 sale with a $167.44 CC fee on the same order nets the
  // order's profit DOWN by the fee (it's a real cost of the sale).
  assert.ok(Transaction.COGS_CATEGORIES.includes('Processing Fee'));
  const noFee = orderRevenueCost([sale(5600), blank(4000)]);
  const withFee = orderRevenueCost([sale(5600), blank(4000), procFee(167.44)]);
  assert.equal(noFee.profit,   1600);                   // 5600 − 4000
  assert.equal(withFee.profit, 1432.56);                // 5600 − (4000 + 167.44)
  assert.equal(round2(noFee.profit - withFee.profit), 167.44);  // exactly the fee
  // And the company rollup counts the fee in COGS the same way.
  assert.equal(summarizeCompanyFinance([], [sale(5600), procFee(167.44)]).cogs, 167.44);
});

test('SAFETY: a fee only ever applies ONCE (computeProcessingFee is on the payment, not the fee row)', () => {
  // The fee is derived from the PAYMENT row; the Processing Fee expense it produces
  // is itself an expense, so feeding it back through computeProcessingFee yields 0 —
  // it can never spawn a fee-on-a-fee.
  const payment = sale(1000, { _id: 'P' });
  const feeDoc = buildProcessingFeeDoc(payment, 'cc');
  assert.equal(computeProcessingFee(feeDoc, 'cc'), 0);  // no fee on the fee
  assert.equal(buildProcessingFeeDoc(feeDoc, 'cc'), null);
});

// ════════════════════════════════════════════════════════════════════════════
// PHASE 2b — HARDENING: malformed/missing data never throws or corrupts a total
// ════════════════════════════════════════════════════════════════════════════
// The finance screen must be unbreakable. These pin that the pure rollups (which
// every report endpoint feeds) coerce or skip garbage rows and keep going —
// NaN/string amounts, null/blank parties, bad dates, missing order #s, weird
// categories — without throwing and without letting one bad row poison a total.

test('HARDENING: garbage ledger rows are coerced/skipped, real rows still total', () => {
  const txns = [
    sale(1000),                                            // the one real row
    { type: 'income',  category: 'Client Sales', amount: 'not-a-number' }, // NaN amount → 0
    { type: 'income',  category: 'Client Sales', amount: null },           // null amount → 0
    { type: 'expense', category: 'Blank COGS',     amount: NaN },            // NaN → 0
    { type: 'expense', category: null,             amount: 50 },             // null category → not COGS, ignored from cost
    null,                                                  // a null row
    undefined,                                             // an undefined row
    {},                                                    // an empty row
  ];
  // Must not throw, and the real $1000 sale is intact (garbage contributes 0).
  const out = summarizeCompanyFinance([], txns);
  assert.equal(out.revenue, 1000);
  assert.equal(out.cogs,    0);
  assert.equal(out.profit,  1000);
  // Same garbage-tolerance for the per-order definition.
  assert.equal(orderRevenueCost(txns).revenue, 1000);
  assert.equal(orderActualCost(txns).actualCost, 0);
});

test('HARDENING: string/numeric-string amounts coerce via num() (no NaN leak)', () => {
  // A numeric STRING is a real value (num('1500') = 1500); a non-numeric string is 0.
  const out = summarizeCompanyFinance([], [
    { type: 'income',  category: 'Client Sales', amount: '1500' },   // → 1500
    { type: 'expense', category: 'Printer COGS',   amount: '600.50' }, // → 600.50
    { type: 'expense', category: 'Printer COGS',   amount: 'oops' },   // → 0
  ]);
  assert.equal(out.revenue, 1500);
  assert.equal(out.cogs,    600.5);
  assert.equal(out.profit,  899.5);
  assert.ok(Number.isFinite(out.margin));
});

// ── CSV import: a QuickBooks-style refund must not become a mis-typed expense ──
test('inferRowType: explicit Type wins; else infer income from the category', () => {
  // Explicit Type column is authoritative.
  assert.equal(inferRowType('Income', 'Client Sales'), 'income');
  assert.equal(inferRowType('Expense', 'Client Sales'), 'expense');
  assert.equal(inferRowType('income', 'Blank COGS'), 'income');   // user said income, honored
  // Blank/unknown Type → infer from the category (the QuickBooks-export case).
  assert.equal(inferRowType('', 'Client Sales'), 'income');
  assert.equal(inferRowType('', 'Refund'), 'income');             // a refund row → income (credit set from sign)
  assert.equal(inferRowType(undefined, 'Owner Contribution'), 'income');
  assert.equal(inferRowType('', 'Printer COGS'), 'expense');      // a cost category → expense
  assert.equal(inferRowType('', 'Blank COGS'), 'expense');
  assert.equal(inferRowType('', ''), 'expense');                  // truly ambiguous → expense (most ledger lines)
  assert.equal(inferRowType('', 'refund'), 'income');             // case-insensitive
  // The key bug guard: a NEGATIVE-amount Refund with NO Type column → income (so,
  // combined with isCredit-from-negative-sign, it nets revenue down — not a phantom
  // expense). inferRowType decides type; the import sets isCredit = amount < 0.
  assert.equal(inferRowType('', 'Refund'), 'income');
});

test('HARDENING: paymentGapsForOrders tolerates bad orders, dates and parties', () => {
  const orders = [
    null,                                                    // skipped
    order({ orderNumber: '',  totalValue: 500 }),            // no number → skipped
    order({ orderNumber: '#0000030', totalValue: 1000, paid: false, companyName: null, clientName: '' }), // null/blank party
  ];
  const txns = [
    null,
    { type: 'expense', category: 'Blank COGS', amount: 400, orderNumber: '30', date: 'not-a-date' }, // bad date, valid cost
    sale(300, { orderNumber: '30' }),
  ];
  let out;
  assert.doesNotThrow(() => { out = paymentGapsForOrders(orders, txns); });
  const row = out.orders.find((r) => r.orderNumber === '30');
  assert.ok(row);
  assert.equal(row.client, '—');                             // null/blank party → em dash, no crash
  assert.equal(row.cost, 400);
  assert.equal(row.collected, 300);
  assert.equal(row.outstanding, 700);                        // billed 1000 − collected 300
});

// ── companyKeyByOrderNumber (the byOrder → CRM card deep-link bridge) ──────────
test('companyKeyByOrderNumber: keys by CANONICAL order # to the order\'s stored companyKey', () => {
  const m = companyKeyByOrderNumber([
    { orderNumber: '#0000021', companyKey: 'acme' },
    { orderNumber: 'PO-022',   companyKey: 'globex' },
  ]);
  // "#0000021" / "PO-022" normalize to "21" / "22" — the SAME keys a finance row
  // lands on — and map to the authoritative stored companyKey.
  assert.equal(m['21'], 'acme');
  assert.equal(m['22'], 'globex');
});

test('companyKeyByOrderNumber: leading-zero variants of ONE order collapse to one key', () => {
  const m = companyKeyByOrderNumber([
    { orderNumber: '0000021', companyKey: 'acme' },
    { orderNumber: '21',      companyKey: 'acme' },   // same company, same canonical #
  ]);
  assert.equal(m['21'], 'acme');
});

test('companyKeyByOrderNumber: ANTI-MISLINK — two different companies sharing a number → not linked', () => {
  const m = companyKeyByOrderNumber([
    { orderNumber: '21', companyKey: 'acme' },
    { orderNumber: '21', companyKey: 'globex' },   // genuine collision: DON'T guess
  ]);
  // Ambiguous → '' so the UI disables the link instead of mis-linking to a
  // near-miss company that merely shares the order number.
  assert.equal(m['21'], '');
});

test('companyKeyByOrderNumber: a blank/absent companyKey never overwrites a real one (and yields no link alone)', () => {
  const m = companyKeyByOrderNumber([
    { orderNumber: '21', companyKey: 'acme' },
    { orderNumber: '21', companyKey: '' },          // blank must not clobber 'acme'
    { orderNumber: '22', companyKey: '' },          // only blanks → no entry to link on
    { orderNumber: '',   companyKey: 'ghost' },     // no number → skipped
    null,                                            // tolerated
  ]);
  assert.equal(m['21'], 'acme');
  assert.equal(m['22'] || '', '');
});

// ── Owner-managed categories ─────────────────────────────────────────────────
const { normalizeCategoryName, categoriesWithCustom } = require('../finances');

test('normalizeCategoryName trims, collapses whitespace, caps length', () => {
  assert.equal(normalizeCategoryName('  Office   Snacks '), 'Office Snacks');
  assert.equal(normalizeCategoryName(''), '');
  assert.equal(normalizeCategoryName(null), '');
  assert.equal(normalizeCategoryName('x'.repeat(60)).length, 40);
});

test('categoriesWithCustom: built-ins first, customs before Other, dupes dropped case-insensitively', () => {
  const cats = categoriesWithCustom(['Office Snacks', 'office snacks', 'SOFTWARE', '  ', 'Trade Shows']);
  assert.equal(cats[cats.length - 1], 'Other');                    // catch-all stays last
  assert.ok(cats.includes('Office Supplies'));                     // new built-in present
  assert.ok(cats.includes('Office Snacks') && cats.includes('Trade Shows'));
  assert.equal(cats.filter((c) => c.toLowerCase() === 'office snacks').length, 1); // deduped
  assert.equal(cats.filter((c) => c.toLowerCase() === 'software').length, 1);      // built-in wins
  assert.deepEqual(categoriesWithCustom([]), categoriesWithCustom());              // no customs = built-ins
});
