// controllers/__tests__/quoteRepush.test.js
//
//   node --test controllers/__tests__/quoteRepush.test.js
//
// The builder autosaves quoteLines constantly; "Push to client" — and sharing a
// link, which is also a push — is the moment those edits reach the client.
//
// Nothing checked whether an edit landed on an option the client had ALREADY
// accepted. So correcting an accepted line from 100 @ $12 to 150 @ $14 and
// pushing left the acceptance flag on: the order recorded the client as having
// agreed to something they never saw, at a price they never agreed to. And
// `accepted` is what computeQuoteTotals bills off, so the money followed
// silently. updateOrder's MONEY_LOCKED does not cover this — it locks the
// confirmation once approved, not the quote before it.
//
// The two halves worth pinning: a change to what the CLIENT sees clears the
// pick, and a change to the owner's own economics does not.

const test = require('node:test');
const assert = require('node:assert/strict');

const { staleAcceptances, clearStaleAcceptances, stillPicked } = require('../../utils/quoteRepush');

const line = (over = {}) => ({
  lid: 'a', group: 'Tees', qty: 100, unitPrice: 12, description: 'Heavy Tee',
  styleCode: 'G500', color: '', printType: 'Screen print', printDetails: '3c front',
  turnaroundWeeks: 2, colorOptions: [], accepted: true,
  blankCost: 3.2, printCost: 4.55, markup: 1.4, printerKey: 'heritage',
  ...over,
});

test('re-pricing an accepted option clears the pick', () => {
  const published = [line({ accepted: true })];
  const live = [line({ qty: 150, unitPrice: 14 })];
  assert.deepEqual(staleAcceptances(live, published).stale, ['a']);
});

test("re-costing the owner's own side does NOT clear the pick", () => {
  // The client never saw blankCost, printCost, markup or the printer. Throwing
  // away their yes because the owner corrected his margin would be its own bug.
  const published = [line()];
  const live = [line({ blankCost: 4.1, printCost: 5.2, markup: 1.9, printerKey: 'sanmar' })];
  assert.deepEqual(staleAcceptances(live, published).stale, []);
});

test('changing what they are buying clears the pick', () => {
  for (const change of [
    { description: 'Premium Tee' }, { styleCode: 'BC3001' }, { color: 'Maroon' },
    { printType: 'DTG' }, { printDetails: '1c front' }, { group: 'Hoodies' },
  ]) {
    const stale = staleAcceptances([line(change)], [line()]).stale;
    assert.deepEqual(stale, ['a'], `${JSON.stringify(change)} should clear the pick`);
  }
});

test('a 2-week job becoming a 6-week one clears the pick', () => {
  // A promise, not a price — but absolutely a change to what they said yes to.
  assert.deepEqual(staleAcceptances([line({ turnaroundWeeks: 6 })], [line()]).stale, ['a']);
});

test('changing the colours on offer clears the pick', () => {
  const published = [line({ colorOptions: [{ name: 'Black' }, { name: 'Maroon' }] })];
  const live = [line({ colorOptions: [{ name: 'Black' }] })];
  assert.deepEqual(staleAcceptances(live, published).stale, ['a']);
});

test('re-ordering the same colours is not a change', () => {
  const published = [line({ colorOptions: [{ name: 'Black' }, { name: 'Maroon' }] })];
  const live = [line({ colorOptions: [{ name: 'Maroon' }, { name: 'Black' }] })];
  assert.deepEqual(staleAcceptances(live, published).stale, []);
});

test('an unchanged push clears nothing', () => {
  assert.deepEqual(staleAcceptances([line()], [line()]).stale, []);
});

test('a standalone line has no pick to invalidate', () => {
  // Ungrouped lines are always part of the order — there was never a yes.
  const published = [line({ group: '', qty: 100 })];
  const live = [line({ group: '', qty: 500 })];
  assert.deepEqual(staleAcceptances(live, published).stale, []);
});

test('a line with no previous snapshot is left alone rather than guessed at', () => {
  assert.deepEqual(staleAcceptances([line()], []).stale, []);
});

test("clearing takes the client's answer with it", () => {
  // colorSplit and pickedQty are their ANSWER to an offer that just changed;
  // leaving them behind would keep billing an allocation against quantities
  // and colours that no longer match it.
  const live = [line({ qty: 150, colorSplit: [{ name: 'Black', qty: 100 }], pickedQty: 75 })];
  clearStaleAcceptances(live, [line()]);
  assert.equal(live[0].accepted, false);
  assert.deepEqual(live[0].colorSplit, []);
  assert.equal(live[0].pickedQty, 0);
});

test('an untouched line keeps its acceptance and its allocation', () => {
  const published = [line(), line({ lid: 'b', description: 'Hoodie' })];
  const live = [line({ qty: 150 }), line({ lid: 'b', description: 'Hoodie', colorSplit: [{ name: 'Black', qty: 60 }] })];
  clearStaleAcceptances(live, published);
  assert.equal(live[0].accepted, false, 'the changed one is cleared');
  assert.equal(live[1].accepted, true, 'the untouched one is not');
  assert.deepEqual(live[1].colorSplit, [{ name: 'Black', qty: 60 }]);
});

test('the picked stamp only survives while something grouped is still accepted', () => {
  assert.equal(stillPicked([line({ accepted: false })]), false);
  assert.equal(stillPicked([line({ accepted: false }), line({ lid: 'b', accepted: true })]), true);
  // A standalone line is not a pick, so it must not hold the stamp on alone.
  assert.equal(stillPicked([line({ group: '', accepted: true })]), false);
});

test('the reason carries a name the owner will recognise', () => {
  const { reasons } = staleAcceptances([line({ qty: 150 })], [line()]);
  assert.deepEqual(reasons, [{ lid: 'a', description: 'Heavy Tee' }]);
});
