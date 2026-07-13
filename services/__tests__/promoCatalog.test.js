// services/__tests__/promoCatalog.test.js
//   node --test services/__tests__/promoCatalog.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePromoProduct, breakAt, quoteAt } = require('../promoCatalog');

test('normalizePromoProduct cleans, sorts and de-dupes breaks; rejects nameless rows', () => {
  const p = normalizePromoProduct({
    name: '  Custom Grinder ',
    sku: 'CGNDR-HP',
    moq: '250',
    clientPriceBreaks: [
      { qty: 500, price: 2.6 }, { qty: 100, price: 3.05 },
      { qty: 500, price: 2.55 },              // dup qty — last wins
      { qty: 0, price: 9 }, { qty: 50 },       // junk rows drop
    ],
    netCostBreaks: [{ qty: 100, cost: 2.44 }],
    flags: ['x', '', 'y'],
    hacker: 'nope',
  });
  assert.equal(p.name, 'Custom Grinder');
  assert.equal(p.moq, 250);
  assert.deepEqual(p.clientPriceBreaks, [{ qty: 100, price: 3.05 }, { qty: 500, price: 2.55 }]);
  assert.deepEqual(p.netCostBreaks, [{ qty: 100, cost: 2.44 }]);
  assert.deepEqual(p.flags, ['x', 'y']);
  assert.equal(p.hacker, undefined);
  assert.equal(normalizePromoProduct({ sku: 'X' }), null, 'no name → rejected');
});

test('breakAt picks the largest tier at or below the quantity', () => {
  const breaks = [{ qty: 100, price: 3 }, { qty: 500, price: 2.5 }, { qty: 1000, price: 2.2 }];
  assert.deepEqual(breakAt(breaks, 750, 'price'), { qty: 500, value: 2.5, belowMinimum: false });
  assert.deepEqual(breakAt(breaks, 100, 'price'), { qty: 100, value: 3, belowMinimum: false });
  assert.deepEqual(breakAt(breaks, 5000, 'price'), { qty: 1000, value: 2.2, belowMinimum: false });
});

test('breakAt below the lowest tier flags belowMinimum (no invented price)', () => {
  const breaks = [{ qty: 100, price: 3 }];
  assert.deepEqual(breakAt(breaks, 50, 'price'), { qty: 100, value: 3, belowMinimum: true });
  assert.deepEqual(breakAt([], 50, 'price'), { qty: 0, value: 0, belowMinimum: false });
});

test('quoteAt returns both sides of the money + the margin between them', () => {
  const product = {
    moq: null,
    clientPriceBreaks: [{ qty: 100, price: 3.05 }, { qty: 500, price: 2.55 }],
    netCostBreaks: [{ qty: 100, cost: 2.44 }, { qty: 500, cost: 2.16 }],
  };
  const q = quoteAt(product, 500);
  assert.equal(q.price, 2.55);
  assert.equal(q.cost, 2.16);
  assert.ok(Math.abs(q.marginPct - ((2.55 - 2.16) / 2.55) * 100) < 0.01);
  assert.equal(q.belowMinimum, false);
});

test('quoteAt flags a quantity under the MOQ / tier floor', () => {
  const product = {
    moq: 250,
    clientPriceBreaks: [{ qty: 100, price: 3.05 }],
    netCostBreaks: [{ qty: 100, cost: 2.44 }],
  };
  assert.equal(quoteAt(product, 100).belowMinimum, true, 'under explicit MOQ');
  assert.equal(quoteAt(product, 250).belowMinimum, false);
  assert.equal(quoteAt({ clientPriceBreaks: [{ qty: 100, price: 3 }], netCostBreaks: [] }, 50).belowMinimum, true, 'under tier floor');
});
