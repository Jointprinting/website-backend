// controllers/__tests__/missingReceipts.test.js
//
// Pins the "did I forget to enter a cost receipt?" math (controllers/finances.js
// missingReceiptsForOrders) — the owner's check that an active in-progress order
// has the COGS receipts it's expected to have. Pure-logic, no DB:
//
//   node --test controllers/__tests__/missingReceipts.test.js
//
// "Smart per order": a PRINTER receipt is always expected; a BLANKS receipt only
// when JP sourced the blanks (a PO with blanksProvided===true, or no POs yet =
// the ~99% default); a SHIPPING receipt only when the order carried freight
// (shippingCost > 0). Only orders that are paid OR in production (and not
// delivered/cancelled) are considered. These tests keep that contract from drifting.

const test = require('node:test');
const assert = require('node:assert/strict');

const { missingReceiptsForOrders, expectedReceiptCats, orderInProgress } = require('../finances');

// Factories. A cost row counts as a PRESENT receipt only when it carries a
// receiptUrl (the proof), so the factory attaches one by default; pass
// `{ receiptUrl: '' }` to model a logged-but-unreceipted cost.
const expense = (category, over = {}) => ({ type: 'expense', category, orderNumber: '1', receiptUrl: 'r.pdf', ...over });
const order = (over = {}) => ({ orderNumber: '1', status: 'in_production', paid: false, shippingCost: 0, companyName: 'Acme', ...over });
const po = (over = {}) => ({ blanksProvided: true, ...over });

// ── trigger: which orders are even considered ────────────────────────────────
test('orderInProgress: paid OR in-production statuses, never delivered/cancelled/unpaid-quote', () => {
  assert.equal(orderInProgress({ status: 'quoted', paid: true }), true);     // paid → counts even if still "quoted"
  assert.equal(orderInProgress({ status: 'placed', paid: false }), true);
  assert.equal(orderInProgress({ status: 'in_production', paid: false }), true);
  assert.equal(orderInProgress({ status: 'shipped', paid: false }), true);
  assert.equal(orderInProgress({ status: 'quoted', paid: false }), false);   // not started
  assert.equal(orderInProgress({ status: 'delivered', paid: true }), false); // done
  assert.equal(orderInProgress({ status: 'cancelled', paid: true }), false); // no sale
  assert.equal(orderInProgress(null), false);
});

// ── expected categories (smart per order) ────────────────────────────────────
test('expectedReceiptCats: printer always; blanks unless a PO supplies them; shipping only with freight', () => {
  // No POs yet → assume JP supplies blanks (printer + blanks), no shipping cost.
  assert.deepEqual(expectedReceiptCats(order({ shippingCost: 0 }), []), ['Printer COGS', 'Blank COGS']);
  // Printer supplies their own blanks (every PO blanksProvided=false) → no blanks receipt.
  assert.deepEqual(expectedReceiptCats(order(), [po({ blanksProvided: false })]), ['Printer COGS']);
  // Any PO with JP-supplied blanks → blanks expected.
  assert.deepEqual(
    expectedReceiptCats(order(), [po({ blanksProvided: false }), po({ blanksProvided: true })]),
    ['Printer COGS', 'Blank COGS'],
  );
  // Freight on the order → shipping expected too.
  assert.deepEqual(
    expectedReceiptCats(order({ shippingCost: 25 }), [po({ blanksProvided: false })]),
    ['Printer COGS', 'Shipping'],
  );
});

// ── the flag itself ──────────────────────────────────────────────────────────
test('in-progress order with no receipts → flags printer + blanks (no shipping cost)', () => {
  const r = missingReceiptsForOrders([order({ orderNumber: '40', paid: true })], [], {});
  assert.equal(r.count, 1);
  assert.deepEqual(r.orders[0].missing, ['Printer COGS', 'Blank COGS']);
  assert.deepEqual(r.orders[0].missingLabels, ['printer', 'blanks']);
  assert.equal(r.orders[0].paid, true);
});

test('printer receipt present, blanks still missing → flags only blanks', () => {
  const r = missingReceiptsForOrders(
    [order({ orderNumber: '41' })],
    [expense('Printer COGS', { orderNumber: '41' })],
    {},
  );
  assert.equal(r.count, 1);
  assert.deepEqual(r.orders[0].missing, ['Blank COGS']);
});

test('printer supplies blanks (PO) + printer receipt present → fully receipted, not flagged', () => {
  const r = missingReceiptsForOrders(
    [order({ orderNumber: '42' })],
    [expense('Printer COGS', { orderNumber: '0000042' })],   // leading-zero variant still matches
    { '42': [po({ blanksProvided: false })] },
  );
  assert.equal(r.count, 0);
});

test('shipping cost on the order but no shipping receipt → flags shipping', () => {
  const r = missingReceiptsForOrders(
    [order({ orderNumber: '43', shippingCost: 18 })],
    [expense('Printer COGS', { orderNumber: '43' }), expense('Blank COGS', { orderNumber: '43' })],
    {},
  );
  assert.equal(r.count, 1);
  assert.deepEqual(r.orders[0].missing, ['Shipping']);
});

test('cancelled / unpaid-quote / delivered orders are never flagged — only ongoing work', () => {
  const r = missingReceiptsForOrders([
    order({ orderNumber: '50', status: 'delivered', paid: true }),  // delivered = job done → not re-audited
    order({ orderNumber: '51', status: 'cancelled', paid: true }),  // cancelled → never
    order({ orderNumber: '52', status: 'quoted', paid: false }),    // pre-placement, unpaid → never
  ], [], {});
  assert.equal(r.count, 0);
});

test('a cost logged WITHOUT a receipt file is still missing (the proof, not just the number)', () => {
  const r = missingReceiptsForOrders(
    [order({ orderNumber: '44', paid: true })],
    [expense('Printer COGS', { orderNumber: '44', receiptUrl: '' }),   // cost logged, no receipt attached
     expense('Blank COGS',   { orderNumber: '44' })],                  // blanks receipted (factory default)
    {},
  );
  assert.equal(r.count, 1);
  assert.deepEqual(r.orders[0].missing, ['Printer COGS']);
});

test('newest order number first', () => {
  const r = missingReceiptsForOrders([
    order({ orderNumber: '7', paid: true }),
    order({ orderNumber: '23', paid: true }),
    order({ orderNumber: '12', paid: true }),
  ], [], {});
  assert.deepEqual(r.orders.map((o) => o.orderNumber), ['23', '12', '7']);
});
