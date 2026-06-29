// controllers/__tests__/orderReconcile.test.js
//
// Pins the "reconcile a scattered order's numbers down to one canonical #" logic
// (services/orderReconcile.buildReconcilePlan). Pure, no DB:
//
//   node --test controllers/__tests__/orderReconcile.test.js
//
// The real case: Happy Leaf is ONE order written as #141 in the ledger (incl. a row
// whose PARTY is the blank vendor S&S, linked only by #141), and #1050/#1052 elsewhere.
// All of it must fold onto #138 — without touching a row already on #138 or an unrelated
// order, and falling back to #141 only if #138 is a different client's order.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReconcilePlan, planForTarget, getTarget } = require('../../services/orderReconcile');

const T = getTarget('happyleaf');

const txn = (over = {}) => ({ _id: Math.random().toString(36).slice(2), type: 'expense', amount: 0, party: '', orderNumber: '', invoiceNumber: '', description: '', ...over });
const ord = (over = {}) => ({ _id: Math.random().toString(36).slice(2), orderNumber: '', companyName: '', clientName: '', companyKey: '', status: 'delivered', totalValue: 0, archived: false, ...over });

test('happyleaf target exists with canonical 138 / fallback 141', () => {
  assert.ok(T);
  assert.equal(T.canonical, '138');
  assert.equal(T.fallback, '141');
});

test('folds the three Happy Leaf ledger rows (#141 + vendor-party row) onto #138', () => {
  const txns = [
    txn({ orderNumber: '141', type: 'income',  amount: 1537.16, party: 'Happy Leaf Dispensary', description: 'Sales' }),
    txn({ orderNumber: '141', type: 'expense', amount: 481.63,  party: 'S&S Activewear', description: 'Blanks' }),  // linked ONLY by #141
    txn({ orderNumber: '141', type: 'expense', amount: 45.96,   party: 'Happy Leaf Dispensary', description: 'CC fee' }),
  ];
  const out = buildReconcilePlan(txns, []);
  assert.equal(out.summary.count, 3);
  assert.equal(out.summary.txnCount, 3);
  assert.equal(out.plans.length, 1);
  assert.equal(out.plans[0].canonical, '138');
  for (const c of out.plans[0].changes) { assert.equal(c.from, '141'); assert.equal(c.to, '138'); }
});

test('also folds the #1050 / #1052 alias rows and the order doc', () => {
  const txns = [
    txn({ orderNumber: '1050', party: 'Happy Leaf Dispensary', amount: 100 }),
    txn({ orderNumber: '', invoiceNumber: '1052', party: 'Happy Leaf Dispensary', amount: 50 }), // tagged only by invoice #
  ];
  const orders = [ord({ orderNumber: '1050', companyName: 'Happy Leaf Dispensary', totalValue: 1537.16 })];
  const out = buildReconcilePlan(txns, orders);
  assert.equal(out.summary.txnCount, 2);
  assert.equal(out.summary.orderCount, 1);
  assert.equal(out.summary.count, 3);
  const orderChange = out.plans[0].changes.find((c) => c.collection === 'Order');
  assert.equal(orderChange.from, '1050');
  assert.equal(orderChange.to, '138');
});

test('a row ALREADY on #138 is left alone (idempotent — re-running folds nothing)', () => {
  const txns = [
    txn({ orderNumber: '138', party: 'Happy Leaf Dispensary', amount: 1537.16 }), // already canonical
  ];
  const orders = [ord({ orderNumber: '138', companyName: 'Happy Leaf Dispensary' })];
  const out = buildReconcilePlan(txns, orders);
  assert.equal(out.summary.count, 0);
  assert.equal(out.plans.length, 0);
});

test('an unrelated order (different client, non-alias number) is never touched', () => {
  const txns = [
    txn({ orderNumber: '200', party: 'Some Other Co', amount: 999 }),
    txn({ orderNumber: '141', party: 'Happy Leaf Dispensary', amount: 100 }),  // only this folds
  ];
  const out = buildReconcilePlan(txns, []);
  assert.equal(out.summary.count, 1);
  assert.equal(out.plans[0].changes[0].party, 'Happy Leaf Dispensary');
});

test('falls back to #141 when #138 is already a DIFFERENT client\'s order', () => {
  const txns = [txn({ orderNumber: '1050', party: 'Happy Leaf Dispensary', amount: 100 })];
  const orders = [
    ord({ orderNumber: '138', companyName: 'Coastline Dispensary' }), // #138 is someone else's real order
  ];
  const out = buildReconcilePlan(txns, orders);
  assert.equal(out.plans[0].canonical, '141');     // refuses to collide → fallback
  assert.equal(out.plans[0].changes.find((c) => c.collection === 'Transaction').to, '141');
});

test('archived order docs are ignored', () => {
  const orders = [ord({ orderNumber: '141', companyName: 'Happy Leaf Dispensary', archived: true })];
  const out = buildReconcilePlan([], orders);
  assert.equal(out.summary.count, 0);
});

test('leading-zero variants of an alias still match (canonical key)', () => {
  const txns = [txn({ orderNumber: '0000141', party: 'Happy Leaf Dispensary', amount: 100 })];
  const out = buildReconcilePlan(txns, []);
  assert.equal(out.summary.count, 1);
  assert.equal(out.plans[0].changes[0].to, '138');
});

test('targetKey opt narrows the plan to one target', () => {
  const txns = [txn({ orderNumber: '141', party: 'Happy Leaf Dispensary', amount: 100 })];
  assert.equal(buildReconcilePlan(txns, [], { targetKey: 'happyleaf' }).summary.count, 1);
  assert.equal(buildReconcilePlan(txns, [], { targetKey: 'nope' }).summary.count, 0);
});
