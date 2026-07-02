// controllers/__tests__/paymentGaps.test.js
//
// Pins the revenue-gap math (controllers/finances.js paymentGapsForOrders) — the
// additive lens that explains why net profit reads too low: vendor COST receipts
// were entered without the matching CLIENT PAYMENT income. Pure-logic, no DB:
//
//   node --test controllers/__tests__/paymentGaps.test.js
//
// Per order it lines up billed (Order.totalValue) vs collected (Σ signed income/
// 'Client Sales') vs cost (Σ signed COGS = orderActualCost), flags
// cost-without-payment and outstanding, and totals them. It must REUSE the same
// signed()/normalizeOrderNumber()/orderActualCost() rules as the P&L — these tests
// keep it from drifting.

const test = require('node:test');
const assert = require('node:assert/strict');

const { paymentGapsForOrders, orderActualCost } = require('../finances');

// Ledger-row + order factories (amount always positive; isCredit flips direction).
const sale   = (amount, over = {}) => ({ type: 'income',  category: 'Client Sales', amount, ...over });
const blank  = (amount, over = {}) => ({ type: 'expense', category: 'Blank COGS',     amount, ...over });
const printc = (amount, over = {}) => ({ type: 'expense', category: 'Printer COGS',   amount, ...over });
const order  = (over = {}) => ({ orderNumber: '1', totalValue: 0, paid: false, companyName: '', clientName: '', ...over });

// ── cost-without-payment (the loudest flag — what hides the real profit) ─────
test('cost recorded but ZERO collected → flagged; leading-zero variants merge', () => {
  const r = paymentGapsForOrders(
    [order({ orderNumber: '21', companyName: 'NJ Dental 1', totalValue: 0 })],
    [blank(300, { orderNumber: '21' }), printc(200, { orderNumber: '0000021' })],  // same order
  );
  assert.equal(r.orders.length, 1);
  const row = r.orders[0];
  assert.equal(row.orderNumber, '21');
  assert.equal(row.client, 'NJ Dental 1');
  assert.equal(row.cost, 500);                 // 300 + 200 across both variants
  assert.equal(row.collected, 0);
  assert.equal(row.costWithoutPayment, true);
  assert.equal(r.totals.costWithoutPayment, 500);
  assert.equal(r.totals.costWithoutPaymentCount, 1);
});

test('cost reconciles EXACTLY with orderActualCost (no re-derivation)', () => {
  const rows = [blank(300, { orderNumber: '7' }), printc(123.45, { orderNumber: '7' })];
  const r = paymentGapsForOrders([order({ orderNumber: '7', totalValue: 0 })], rows);
  assert.equal(r.orders[0].cost, orderActualCost(rows).actualCost);
});

test('a supplier credit nets the cost DOWN (signed rule reused)', () => {
  const rows = [blank(400, { orderNumber: '25' }), blank(50, { orderNumber: '25', isCredit: true })];
  const r = paymentGapsForOrders([order({ orderNumber: '25', totalValue: 0 })], rows);
  assert.equal(r.orders[0].cost, 350);
  assert.equal(r.totals.costWithoutPayment, 350);
});

test('cost recorded + a customer CREDIT with no offsetting payment (collected < 0) STILL flags', () => {
  // The edge a `collected === 0` check would miss: a refund makes collected net
  // negative, but the order has real cost and no real payment — it must NOT silently
  // drop from the report. Flagged via collected <= 0.
  const rows = [blank(500, { orderNumber: '27' }), sale(0.01, { orderNumber: '27', isCredit: true })];
  const r = paymentGapsForOrders([order({ orderNumber: '27', totalValue: 0 })], rows);
  assert.equal(r.orders.length, 1);
  assert.equal(r.orders[0].cost, 500);
  assert.equal(r.orders[0].collected, -0.01);
  assert.equal(r.orders[0].costWithoutPayment, true);
  assert.equal(r.totals.costWithoutPayment, 500);
  assert.equal(r.totals.costWithoutPaymentCount, 1);
});

// ── billed-but-not-collected (outstanding cash) ──────────────────────────────
test('billed but not (fully) collected → outstanding = billed − collected', () => {
  const r = paymentGapsForOrders([order({ orderNumber: '22', totalValue: 1000 })], [sale(400, { orderNumber: '22' })]);
  const row = r.orders[0];
  assert.equal(row.billed, 1000);
  assert.equal(row.collected, 400);
  assert.equal(row.outstanding, 600);
  assert.equal(row.costWithoutPayment, false);
  assert.equal(r.totals.billedNotCollected, 600);
});

test('a customer-sales credit nets collected DOWN (signed rule reused)', () => {
  const r = paymentGapsForOrders(
    [order({ orderNumber: '24', totalValue: 1000 })],
    [sale(1000, { orderNumber: '24' }), sale(200, { orderNumber: '24', isCredit: true })],  // collected 800
  );
  assert.equal(r.orders[0].collected, 800);
  assert.equal(r.orders[0].outstanding, 200);
});

// ── a fully-collected order is NOT clutter ───────────────────────────────────
test('billed and fully collected → not surfaced; totals stay zero', () => {
  const r = paymentGapsForOrders([order({ orderNumber: '23', totalValue: 1000 })], [sale(1000, { orderNumber: '23' })]);
  assert.equal(r.orders.length, 0);
  assert.equal(r.totals.billedNotCollected, 0);
  assert.equal(r.totals.costWithoutPayment, 0);
});

test('over-collected (collected > billed) → no negative outstanding, not surfaced', () => {
  const r = paymentGapsForOrders([order({ orderNumber: '30', totalValue: 900 })], [sale(1000, { orderNumber: '30' })]);
  assert.equal(r.orders.length, 0);                 // outstanding clamps to 0
  assert.equal(r.totals.billedNotCollected, 0);
});

// ── exclusions / edges ───────────────────────────────────────────────────────
test('rows / orders with no order number are ignored (cannot be linked)', () => {
  const r = paymentGapsForOrders(
    [order({ orderNumber: '', totalValue: 500 }), order({ orderNumber: '0000', totalValue: 700 })],
    [blank(40, { orderNumber: '' }), sale(10, { orderNumber: '' })],
  );
  assert.equal(r.orders.length, 0);
  assert.deepEqual(r.totals, { costWithoutPayment: 0, costWithoutPaymentCount: 0, billedNotCollected: 0 });
});

test('a $0/$0 order (no cost, nothing billed) is not a gap', () => {
  const r = paymentGapsForOrders([order({ orderNumber: '26', totalValue: 0 })], [sale(0, { orderNumber: '26' })]);
  assert.equal(r.orders.length, 0);
});

test('both gaps at once: cost-without-payment AND outstanding, sorted loudest-first', () => {
  const orders = [
    order({ orderNumber: '40', companyName: 'A', totalValue: 0 }),       // cost, no pay
    order({ orderNumber: '41', companyName: 'B', totalValue: 1000 }),    // billed, partly paid
  ];
  const txns = [
    blank(600, { orderNumber: '40' }),                                   // 40: cost 600, collected 0
    sale(300, { orderNumber: '41' }),                                    // 41: billed 1000, collected 300
  ];
  const r = paymentGapsForOrders(orders, txns);
  assert.equal(r.orders.length, 2);
  assert.equal(r.orders[0].orderNumber, '40');     // cost-without-payment sorts first
  assert.equal(r.orders[0].costWithoutPayment, true);
  assert.equal(r.orders[1].orderNumber, '41');
  assert.equal(r.totals.costWithoutPayment, 600);
  assert.equal(r.totals.costWithoutPaymentCount, 1);
  assert.equal(r.totals.billedNotCollected, 700);
});

test('empty / undefined input → empty result', () => {
  const empty = { orders: [], totals: { costWithoutPayment: 0, costWithoutPaymentCount: 0, billedNotCollected: 0 } };
  assert.deepEqual(paymentGapsForOrders([], []), empty);
  assert.deepEqual(paymentGapsForOrders(undefined, undefined), empty);
});
