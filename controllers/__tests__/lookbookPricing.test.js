// controllers/__tests__/lookbookPricing.test.js
//
// Pure-logic checks for the lookbook "Request pricing" submission cleaner —
// the public gallery's write path into a quote-stage project.
//
//   node --test controllers/__tests__/lookbookPricing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanPricingRequest } = require('../lookbooks');

test('picks are capped, keyed, and quantity-clamped', () => {
  const r = cleanPricingRequest({
    picks: [
      { remoteId: 'a', qty: 50 },
      { remoteId: 'b', qty: -5 },        // garbage → 1
      { remoteId: 'c', qty: 9999999 },   // clamped to 100k
      { qty: 10 },                       // no remoteId → dropped
    ],
  });
  assert.equal(r.picks.length, 3);
  assert.deepEqual(r.picks.map((p) => p.qty), [50, 1, 100000]);
});

test('a 31st pick is dropped (cap 30)', () => {
  const picks = Array.from({ length: 31 }, (_, i) => ({ remoteId: `m${i}`, qty: 10 }));
  assert.equal(cleanPricingRequest({ picks }).picks.length, 30);
});

test('contact strings are length-bound and trimmed', () => {
  const r = cleanPricingRequest({ by: `  ${'x'.repeat(300)}  `, email: 'a@b.co', note: 'y'.repeat(5000) });
  assert.ok(r.by.length <= 120);
  assert.equal(r.email, 'a@b.co');
  assert.equal(r.note.length, 2000);
});

test('a trailing 2-letter state in ship-to seeds shipToState; anything else does not', () => {
  assert.equal(cleanPricingRequest({ shipTo: '420 High St, Trenton, NJ' }).shipToState, 'NJ');
  assert.equal(cleanPricingRequest({ shipTo: 'Trenton New Jersey' }).shipToState, '');
  assert.equal(cleanPricingRequest({ shipTo: '' }).shipToState, '');
});

test('empty submission yields no picks — the endpoint 400s on that', () => {
  assert.equal(cleanPricingRequest({}).picks.length, 0);
});
