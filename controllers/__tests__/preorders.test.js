// controllers/__tests__/preorders.test.js
//   node --test controllers/__tests__/preorders.test.js
// Pure pieces behind preorder links: the commitment tally and item cleaning.

const test = require('node:test');
const assert = require('node:assert/strict');

const { _tally, _cleanItems } = require('../preorders');

test('tally: people dedupe by name (case-insensitive), units sum, per-item/size rollup', () => {
  const t = _tally([
    { name: 'Dana', itemId: 'tee', size: 'M', qty: 2 },
    { name: 'dana', itemId: 'tee', size: 'L', qty: 1 },
    { name: 'Ray', itemId: 'tee', size: 'M', qty: 3 },
    { name: 'Ray', itemId: 'hat', size: '', qty: 4 },
  ]);
  assert.equal(t.people, 2);
  assert.equal(t.totalQty, 10);
  assert.equal(t.byItem.tee.qty, 6);
  assert.equal(t.byItem.tee.bySize.M, 5);
  assert.equal(t.byItem.tee.bySize.L, 1);
  assert.equal(t.byItem.hat.bySize['—'], 4);
});

test('tally: empty/missing commitments → zeroes, not crashes', () => {
  assert.deepEqual(_tally([]), { people: 0, totalQty: 0, byItem: {} });
  assert.deepEqual(_tally(undefined), { people: 0, totalQty: 0, byItem: {} });
});

test('cleanItems: labels required, ids minted when missing, sizes trimmed and capped', () => {
  const items = _cleanItems([
    { label: '  Staff tee  ', sizes: ['S', 'M', ' L ', '', 'XL'] },
    { label: '' },                       // dropped — no label
    { id: 'keep-me', label: 'Hat' },     // explicit id survives
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0].label, 'Staff tee');
  assert.deepEqual(items[0].sizes, ['S', 'M', 'L', 'XL']);
  assert.ok(items[0].id.length >= 8);
  assert.equal(items[1].id, 'keep-me');
  assert.deepEqual(items[1].sizes, []);
});

test('cleanItems: caps the list at 20 and never returns unlabeled rows', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ label: `Item ${i}` }));
  assert.equal(_cleanItems(many).length, 20);
  assert.equal(_cleanItems(null).length, 0);
});
