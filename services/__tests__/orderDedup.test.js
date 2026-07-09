// services/__tests__/orderDedup.test.js
//
//   node --test services/__tests__/orderDedup.test.js
//
// The real-world case: The CannaBoss Lady had every job TWICE — a project order
// (#61, quote lines) and a bare QuickBooks/Notion invoice import (#1016, same
// $907.05). The sweep must archive the bare import and keep the project order,
// and must NOT touch a company whose same-amount orders aren't a project↔import pair.

const test = require('node:test');
const assert = require('node:assert/strict');
const { planOrderDedup, isProjectOrder, isBareImport } = require('../orderDedup');

const project = (over = {}) => ({ _id: 'p', companyKey: 'cannaboss', projectNumber: '61',
  quoteLines: [{ accepted: true }], totalValue: 907.05, status: 'delivered', orderDate: '2025-02-23', ...over });
const bareImport = (over = {}) => ({ _id: 'i', companyKey: 'cannaboss', orderNumber: '1016',
  importedFrom: 'notion', totalValue: 907.05, status: 'delivered', paid: true, orderDate: '2025-02-23', ...over });

test('archives the bare import twin, keeps the project order', () => {
  const { groups, toArchive } = planOrderDedup([project(), bareImport()]);
  assert.equal(groups.length, 1);
  assert.equal(toArchive.length, 1);
  assert.equal(toArchive[0]._id, 'i');           // the import is archived
  assert.equal(groups[0].keep[0]._id, 'p');      // the project order is kept
});

test('multiple dup pairs for one company each resolve', () => {
  const orders = [
    project({ _id: 'p1', projectNumber: '61', totalValue: 907.05, orderDate: '2025-02-23' }),
    bareImport({ _id: 'i1', orderNumber: '1016', totalValue: 907.05, orderDate: '2025-02-23' }),
    project({ _id: 'p2', projectNumber: '83-1', totalValue: 3318.34, orderDate: '2025-05-29' }),
    bareImport({ _id: 'i2', orderNumber: '1023', totalValue: 3318.34, orderDate: '2025-05-29' }),
  ];
  const { toArchive } = planOrderDedup(orders);
  assert.deepEqual(toArchive.map((o) => o._id).sort(), ['i1', 'i2']);
});

test('leaves a lone project order alone (no import twin)', () => {
  const { toArchive } = planOrderDedup([project()]);
  assert.equal(toArchive.length, 0);
});

test('leaves two project orders of the same amount alone (no bare import)', () => {
  const orders = [project({ _id: 'p1', projectNumber: '61' }), project({ _id: 'p2', projectNumber: '62' })];
  assert.equal(planOrderDedup(orders).toArchive.length, 0);
});

test('leaves two bare imports of the same amount alone (no project twin to keep)', () => {
  const orders = [bareImport({ _id: 'i1' }), bareImport({ _id: 'i2' })];
  assert.equal(planOrderDedup(orders).toArchive.length, 0);
});

test('does not pair across different companies', () => {
  const orders = [project({ companyKey: 'a' }), bareImport({ companyKey: 'b' })];
  assert.equal(planOrderDedup(orders).toArchive.length, 0);
});

test('does not pair different amounts', () => {
  const orders = [project({ totalValue: 907.05 }), bareImport({ totalValue: 143.51, orderNumber: '1028' })];
  assert.equal(planOrderDedup(orders).toArchive.length, 0);
});

test('dates far apart (> 45d) with the SAME amount are NOT paired', () => {
  const orders = [
    project({ orderDate: '2025-01-01' }),
    bareImport({ orderDate: '2025-09-01' }),
  ];
  assert.equal(planOrderDedup(orders).toArchive.length, 0);
});

test('a missing date does not block a same-company same-amount pair', () => {
  const orders = [project({ orderDate: null }), bareImport({ orderDate: null })];
  assert.equal(planOrderDedup(orders).toArchive.length, 1);
});

test('skips already-archived and cancelled orders', () => {
  const orders = [project(), bareImport({ archived: true })];
  assert.equal(planOrderDedup(orders).toArchive.length, 0);
  const orders2 = [project(), bareImport({ status: 'cancelled' })];
  assert.equal(planOrderDedup(orders2).toArchive.length, 0);
});

test('$0 orders are ignored', () => {
  const orders = [project({ totalValue: 0 }), bareImport({ totalValue: 0 })];
  assert.equal(planOrderDedup(orders).toArchive.length, 0);
});

test('classifiers: a notion import with quote lines is NOT bare (owner built on it)', () => {
  assert.equal(isBareImport({ importedFrom: 'notion', quoteLines: [{ accepted: true }] }), false);
  assert.equal(isProjectOrder({ quoteLines: [{ accepted: true }] }), true);
  assert.equal(isProjectOrder({ projectNumber: '61' }), true);
});