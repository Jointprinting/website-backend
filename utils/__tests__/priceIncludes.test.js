// utils/__tests__/priceIncludes.test.js
//
//   node --test utils/__tests__/priceIncludes.test.js
//
// The approval page used to say "every price is all-in per unit" and stop. The
// owner, reading his own client-facing page: "the copy probably needs work cause
// I don't think it says it includes shipping."
//
// It usually does — lineCogsPerUnit spreads setup and shipping across the line's
// own quantity — but "usually" is exactly why this is derived from the quote
// instead of written into the copy. A promise on a page someone signs has to be
// backed by the lines.

const test = require('node:test');
const assert = require('node:assert/strict');

const { priceIncludesFor } = require('../priceIncludes');

const line = (over = {}) => ({ setupCost: 120, shippingCost: 90, turnaroundWeeks: 2, ...over });

test('freight and setup priced into every option are reported as included', () => {
  const r = priceIncludesFor([line(), line({ setupCost: 60, shippingCost: 45 })]);
  assert.equal(r.shipping, true);
  assert.equal(r.setup, true);
});

test('ONE option without freight suppresses the promise for the whole quote', () => {
  // "Shipping included" would be false for the option they might actually pick,
  // and a wrong promise on a page someone signs is worse than a quiet one.
  const r = priceIncludesFor([line(), line({ shippingCost: 0 })]);
  assert.equal(r.shipping, false);
  assert.equal(r.setup, true, 'setup is judged independently');
});

test('a parked line is not part of the offer and cannot suppress anything', () => {
  const r = priceIncludesFor([line(), line({ shippingCost: 0, hiddenFromClient: true })]);
  assert.equal(r.shipping, true);
});

test('the lead time quoted is the LONGEST on offer', () => {
  // Quoting the shortest would be a promise the slowest option can't keep.
  assert.equal(priceIncludesFor([line({ turnaroundWeeks: 2 }), line({ turnaroundWeeks: 5 })]).turnaroundWeeks, 5);
});

test('no lead time set means the page says nothing, not zero weeks', () => {
  assert.equal(priceIncludesFor([line({ turnaroundWeeks: 0 })]).turnaroundWeeks, 0);
});

test('an empty or junk quote promises nothing', () => {
  for (const bad of [[], null, undefined, [null], [{ hiddenFromClient: true }]]) {
    assert.deepEqual(priceIncludesFor(bad), { setup: false, shipping: false, turnaroundWeeks: 0 });
  }
});

test('no amounts leak — only booleans and a week count', () => {
  const r = priceIncludesFor([line({ setupCost: 999.99, shippingCost: 123.45 })]);
  assert.deepEqual(Object.keys(r).sort(), ['setup', 'shipping', 'turnaroundWeeks']);
  assert.equal(typeof r.setup, 'boolean');
  assert.equal(typeof r.shipping, 'boolean');
  assert.equal(JSON.stringify(r).includes('123.45'), false);
});
