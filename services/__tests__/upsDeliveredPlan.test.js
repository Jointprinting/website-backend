// services/__tests__/upsDeliveredPlan.test.js
//
//   node --test services/__tests__/upsDeliveredPlan.test.js
//
// "Delivered — confirmed by UPS" is written onto a CLIENT-FACING timeline, and
// it used to be written by POSITION: the tick loaded the order, went out to the
// UPS API, then mutated the loaded subdocument and save()d, which Mongoose turns
// into `tracking.steps.4.completedAt`. The timeline is owner-editable — renaming,
// reordering, hiding or adding a step rewrites the whole array — so an edit made
// during that round trip meant index 4 was a different step, and the delivery
// stamp landed on the wrong row of a page the client reads.
//
// These pin the rule that replaced it: the write is keyed on the step's own
// stable id, never on where it happens to sit.

const test = require('node:test');
const assert = require('node:assert/strict');

const { deliveredUpdatePlan } = require('../upsTracking');

const AT = new Date('2026-08-14T18:20:00Z');
const STEP_PATHS = ['tracking.steps.$[s].completedAt', 'tracking.steps.$[s].note'];

test('the step write is keyed on the step id, not its index', () => {
  const plan = deliveredUpdatePlan({}, { step: { id: 'on_the_way' } }, AT);
  assert.deepEqual(plan.arrayFilters, [{ 's.id': 'on_the_way' }]);
  // Nothing in the update may name a position.
  for (const k of Object.keys(plan.set)) assert.ok(!/steps\.\d/.test(k), `${k} is positional`);
});

test('a legacy step with no id falls back to its tracking link, still not a position', () => {
  const plan = deliveredUpdatePlan({}, { step: { link: 'https://ups.com/1Z999AA10123456784' } }, AT);
  assert.deepEqual(plan.arrayFilters, [{ 's.link': 'https://ups.com/1Z999AA10123456784' }]);
});

test('a fresh delivery stamps the order and the step', () => {
  const plan = deliveredUpdatePlan({}, { step: { id: 'final' } }, AT);
  assert.equal(plan.set.status, 'delivered');
  assert.deepEqual(plan.set.deliveredDate, AT);
  assert.deepEqual(plan.set['tracking.steps.$[s].completedAt'], AT);
  assert.equal(plan.set['tracking.steps.$[s].note'], 'Delivered — confirmed by UPS');
});

test('an existing deliveredDate is never overwritten', () => {
  const earlier = new Date('2026-08-01T00:00:00Z');
  const plan = deliveredUpdatePlan({ deliveredDate: earlier }, { step: { id: 'final' } }, AT);
  assert.equal('deliveredDate' in plan.set, false);
  assert.equal(plan.set.status, 'delivered');
});

test("a step the owner already ticked or annotated keeps what they wrote", () => {
  const done = new Date('2026-08-10T00:00:00Z');
  const plan = deliveredUpdatePlan({}, { step: { id: 'final', completedAt: done, note: 'Signed for by Rita' } }, AT);
  for (const p of STEP_PATHS) assert.equal(p in plan.set, false, `${p} should be left alone`);
  // With nothing to write on the step there is no element to target either —
  // an arrayFilter with no matching $[s] path is an error in Mongo.
  assert.equal(plan.arrayFilters, null);
});

test('a partially filled step writes only the missing half', () => {
  const done = new Date('2026-08-10T00:00:00Z');
  const plan = deliveredUpdatePlan({}, { step: { id: 'final', completedAt: done } }, AT);
  assert.equal('tracking.steps.$[s].completedAt' in plan.set, false);
  assert.equal(plan.set['tracking.steps.$[s].note'], 'Delivered — confirmed by UPS');
  assert.deepEqual(plan.arrayFilters, [{ 's.id': 'final' }]);
});
