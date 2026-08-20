// controllers/__tests__/restoreOrder.test.js
//
//   node --test controllers/__tests__/restoreOrder.test.js
//
// deleteOrder has ALWAYS been a soft archive. Its own comment says the project's
// POs are archived too "so an unarchive of the order can restore both" — and
// that unarchive did not exist. Meanwhile the Studio told the owner "Delete
// project? This cannot be undone": a false warning, over a reversible action,
// with no way to reverse it.
//
// The endpoint is thin; the part worth pinning is WHICH POs come back.

const test = require('node:test');
const assert = require('node:assert/strict');

const { restoreOrderPlan } = require('../orders');

test('a live order is not "restored" — the filter requires it to be archived', () => {
  const { orderFilter } = restoreOrderPlan('abc');
  assert.deepEqual(orderFilter, { _id: 'abc', archived: true });
});

test("only the POs THIS delete archived come back", () => {
  // deleteOrder stamps its cascade 'order-deleted'. A PO the owner archived
  // himself beforehand carries 'manual' and must stay archived — restoring the
  // order cannot quietly reverse a separate decision he made.
  const { poFilter } = restoreOrderPlan('abc');
  assert.deepEqual(poFilter, { orderId: 'abc', archived: true, archivedReason: 'order-deleted' });
});

test('the reason is cleared, not left behind as a tombstone', () => {
  // A restored row that still reads archivedReason:'manual' would show up in
  // any future audit as "archived by hand", which it no longer is.
  const { unarchive } = restoreOrderPlan('abc');
  assert.deepEqual(unarchive, { $set: { archived: false, archivedAt: null, archivedReason: '' } });
});

test('the same write is used for the order and its POs', () => {
  const plan = restoreOrderPlan('abc');
  assert.equal(plan.unarchive, plan.unarchive, 'one object, so the two can never drift');
});
