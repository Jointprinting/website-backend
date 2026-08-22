// controllers/__tests__/sourcing.test.js
//
//   node --test controllers/__tests__/sourcing.test.js
//
// The owner's process, verbatim: "I go to distributor central and do research
// til I find a few good suppliers and get quotes til I find a good option then
// id like the winning one saved for future products like that."
//
// Everything except the last step used to be unrepresentable — a vendor could
// only exist as a side effect of a PO, so the suppliers who quoted and lost were
// never recorded, and neither was why.

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanQuote } = require('../sourcing');
const { vendorKey } = require('../../utils/poCost');

test('a quote canonicalizes its vendor with the SAME key the PO builder uses', () => {
  // Deriving it any other way is how a vendor forks — and a forked Vendor gets
  // its own PO counter, which eventually hands the same PO number twice.
  const q = cleanQuote({ vendorName: '  Rug Masters,  Inc. ', unitCost: 8.4 });
  assert.equal(q.vendorKey, vendorKey('Rug Masters,  Inc.'));
  assert.equal(q.vendorName, 'Rug Masters,  Inc.');
});

test('an explicit key wins over one derived from the name', () => {
  const q = cleanQuote({ vendorName: 'Rug Masters', vendorKey: 'rugmasters' });
  assert.equal(q.vendorKey, 'rugmasters');
});

test('"not quoted" is null, not zero', () => {
  // A supplier who never came back and one who quoted $0 are different findings,
  // and $0 would win every comparison.
  const q = cleanQuote({ vendorName: 'No Reply Co' });
  assert.equal(q.unitCost, null);
  assert.equal(q.setupCost, null);
  assert.equal(q.moq, null);
  assert.equal(q.leadTimeDays, null);
});

test('an empty string is also "not quoted" — a cleared input is not a price', () => {
  const q = cleanQuote({ vendorName: 'X', unitCost: '', setupCost: '' });
  assert.equal(q.unitCost, null);
  assert.equal(q.setupCost, null);
});

test('a declined supplier is kept, not dropped', () => {
  // "We asked them and they don't do this" is the finding that stops you asking
  // again next year.
  const q = cleanQuote({ vendorName: 'Wont Do It Ltd', declined: true, notes: 'No rugs under 500 units' });
  assert.equal(q.declined, true);
  assert.equal(q.notes, 'No rugs under 500 units');
});

test('junk in never throws', () => {
  const q = cleanQuote(null);
  assert.equal(q.vendorName, '');
  assert.equal(q.vendorKey, '');
  assert.equal(q.declined, false);
});

// ── bestQuote: the comparison that picks the right supplier ─────────────────
//
// Exercised through the schema method, which is the thing the API and UI call.
const SourcingRequest = require('../../models/SourcingRequest');

test('cheapest ALL-IN wins, not cheapest per unit', () => {
  // The whole reason to compute it: Cheap Unit is $0.40/unit better and $250
  // worse in setup. On 100 pieces that makes them the expensive one, and
  // comparing unit costs alone picks them anyway.
  const doc = new SourcingRequest({
    title: 'Custom 3x5 rug', qtyNeeded: 100,
    quotes: [
      { vendorName: 'Cheap Unit', unitCost: 8.00, setupCost: 250 },   // 8.00 + 2.50 = 10.50
      { vendorName: 'Flat Rate',  unitCost: 8.40, setupCost: 0 },     // 8.40 + 0    =  8.40
    ],
  });
  const best = doc.bestQuote();
  assert.equal(best.quote.vendorName, 'Flat Rate');
  assert.equal(best.allIn, 8.4);
});

test('at a big enough run the setup stops mattering, and it flips', () => {
  const doc = new SourcingRequest({
    title: 'Custom 3x5 rug', qtyNeeded: 5000,
    quotes: [
      { vendorName: 'Cheap Unit', unitCost: 8.00, setupCost: 250 },   // 8.05
      { vendorName: 'Flat Rate',  unitCost: 8.40, setupCost: 0 },     // 8.40
    ],
  });
  assert.equal(doc.bestQuote().quote.vendorName, 'Cheap Unit');
});

test('declined and unquoted suppliers are not candidates', () => {
  const doc = new SourcingRequest({
    title: 'Rug', qtyNeeded: 100,
    quotes: [
      { vendorName: 'Declined', unitCost: 1.00, declined: true },
      { vendorName: 'No Reply' },
      { vendorName: 'Real', unitCost: 9.00 },
    ],
  });
  assert.equal(doc.bestQuote().quote.vendorName, 'Real');
});

test('no usable quotes means no best', () => {
  const doc = new SourcingRequest({ title: 'Rug', quotes: [{ vendorName: 'No Reply' }] });
  assert.equal(doc.bestQuote(), null);
});

test('with no quantity yet, unit cost alone decides', () => {
  // Early in the research the quantity often is not settled. Spreading a setup
  // over an unknown run would invent a number.
  const doc = new SourcingRequest({
    title: 'Rug',
    quotes: [
      { vendorName: 'A', unitCost: 8.00, setupCost: 250 },
      { vendorName: 'B', unitCost: 8.40, setupCost: 0 },
    ],
  });
  assert.equal(doc.bestQuote().quote.vendorName, 'A');
});

test('the category is normalized so "Rugs" and "rugs" are one bucket', () => {
  // The category IS the reuse mechanism — "future products like that" is a
  // category lookup, and two spellings would split the memory in half. Done with
  // a setter rather than a save hook so it also holds on paths that never save.
  const doc = new SourcingRequest({ title: 'Rug', category: '  Rugs ' });
  assert.equal(doc.category, 'rugs');
});
