// utils/__tests__/poStructuredItems.test.js
//
//   node --test utils/__tests__/poStructuredItems.test.js
//
// A purchase order is the document a printer works from and invoices against,
// and until now the only record of what it charged was English. buildPoLines
// computed qty, unit cost and setup, rendered them into a sentence, and dropped
// the numbers — which is why parseUnitCost exists at all: to regex money back
// out of prose this same function had just written.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPoLines } = require('../poCost');

const LINE = {
  name: 'Gildan 5000', color: 'Maroon', qty: 150,
  unitCost: 7.75, setupCost: 60,
  printType: 'Screen Print', printDetails: '3c front',
};

test('the numbers survive alongside the sentence', () => {
  const { items } = buildPoLines([LINE]);
  assert.equal(items.length, 1);
  assert.equal(items[0].qty, 150);
  assert.equal(items[0].unitCost, 7.75);
  assert.equal(items[0].setupCost, 60);
});

test('the rendered strings are BYTE-FOR-BYTE what they were', () => {
  // Every current reader — the PDF, the email, the vendor card — works off
  // `title` and `details`. If this moves, a printer gets a different document.
  const { items } = buildPoLines([LINE]);
  assert.equal(items[0].title, 'Gildan 5000, Maroon, 150 units');
  assert.deepEqual(items[0].details, [
    'Screen Print · 3c front · Maroon',
    '$7.75/unit * 150 units = $1,162.50',
    '$60.00 setup',
  ]);
});

test('the money still adds up the same way', () => {
  const { charges, grandTotal } = buildPoLines([LINE]);
  assert.equal(grandTotal, 7.75 * 150 + 60);
  assert.equal(charges.length, 2);
});

test('absent numbers are null, not zero', () => {
  // null means "not stated". Zero is a price, and a $0 unit cost is the exact
  // thing zeroCostCount exists to warn about — the two must not blur.
  const { items } = buildPoLines([{ name: 'Blank tee', qty: 50 }]);
  assert.equal(items[0].qty, 50);
  assert.equal(items[0].unitCost, null);
  assert.equal(items[0].setupCost, null);
});

test('a costless line is still counted as one to warn about', () => {
  const { zeroCostCount } = buildPoLines([{ name: 'Blank tee', qty: 50 }]);
  assert.equal(zeroCostCount, 1);
});

test('the source line is remembered, so a PO can be diffed against its quote', () => {
  const { items } = buildPoLines([{ ...LINE, lineKey: 'abc123' }]);
  assert.equal(items[0].lineKey, 'abc123');
});
