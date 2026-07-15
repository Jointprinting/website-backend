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
  assert.deepEqual(_tally([]), { people: 0, totalQty: 0, revenue: 0, byItem: {} });
  assert.deepEqual(_tally(undefined), { people: 0, totalQty: 0, revenue: 0, byItem: {} });
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

// ── publicProgress — the FOMO reveal gate ────────────────────────────────────
// Owner's rule: with a MOQ, the public count stays hidden until the drop passes
// it (an empty bar reads as unpopular), then reveals with the goal as social
// proof. No MOQ (0) = a plain open tally. The owner side never uses this.
const { _publicProgress } = require('../preorders');
const T = (people, totalQty) => ({ people, totalQty });

test('publicProgress: MOQ set but NOT reached → count hidden, goal hidden, not reached', () => {
  const p = _publicProgress({ moq: 50 }, T(3, 20));
  assert.equal(p.moqReached, false);
  assert.equal(p.moq, undefined);                 // goal not revealed before it's hit
  assert.deepEqual(p.tally, { people: 0, totalQty: 0 });  // no empty-bar leak
});

test('publicProgress: MOQ reached → count + goal revealed, reached=true', () => {
  const p = _publicProgress({ moq: 50 }, T(9, 64));
  assert.equal(p.moqReached, true);
  assert.equal(p.moq, 50);
  assert.deepEqual(p.tally, { people: 9, totalQty: 64 });
});

test('publicProgress: exactly at MOQ counts as reached (>=)', () => {
  const p = _publicProgress({ moq: 50 }, T(10, 50));
  assert.equal(p.moqReached, true);
  assert.equal(p.tally.totalQty, 50);
});

test('publicProgress: no MOQ (0) → plain open tally, never a "goal reached" badge', () => {
  const shown = _publicProgress({ moq: 0 }, T(2, 7));
  assert.equal(shown.moqReached, false);          // no goal to reach
  assert.equal(shown.moq, undefined);
  assert.deepEqual(shown.tally, { people: 2, totalQty: 7 });
  // nothing committed yet → still nothing to show
  const empty = _publicProgress({ moq: 0 }, T(0, 0));
  assert.deepEqual(empty.tally, { people: 0, totalQty: 0 });
});

// ── Brand variants + revenue (per-design pricing) ────────────────────────────
test('_cleanItems: brand variants — name required, price money-rounded, colors capped', () => {
  const [it] = _cleanItems([{
    label: 'Staff tee',
    sizes: ['S', 'M'],
    variants: [
      { name: 'Gildan 5000', price: '18.5', colors: ['Black', 'White', ' ', 'Navy'] },
      { name: 'Bella 3001', price: 24.999, colors: ['Vintage Black'] },
      { name: '', price: 10 },                       // no name → dropped
    ],
  }]);
  assert.equal(it.variants.length, 2);
  assert.equal(it.variants[0].name, 'Gildan 5000');
  assert.equal(it.variants[0].price, 18.5);
  assert.deepEqual(it.variants[0].colors, ['Black', 'White', 'Navy']);   // blank dropped
  assert.equal(it.variants[1].price, 25);                                // rounded to cents
  assert.ok(it.variants[0].id);                                          // id minted
});

test('_cleanItems: a legacy item with no variants stays exactly as before', () => {
  const [it] = _cleanItems([{ label: 'Promo mug', sizes: [] }]);
  assert.equal(it.label, 'Promo mug');
  assert.deepEqual(it.variants, []);
});

test('tally: committed revenue = Σ qty × unitPrice, with per-item + per-variant rollup', () => {
  const t = _tally([
    { name: 'Dana', itemId: 'tee', variant: 'Gildan', color: 'Black', size: 'M', qty: 2, unitPrice: 18.5 },
    { name: 'Ray',  itemId: 'tee', variant: 'Bella',  color: 'Navy',  size: 'L', qty: 1, unitPrice: 25 },
    { name: 'Ray',  itemId: 'hat', qty: 3, unitPrice: 12 },                 // no variant (legacy-style)
  ]);
  assert.equal(t.totalQty, 6);
  assert.equal(t.revenue, 18.5 * 2 + 25 + 12 * 3);        // 98
  assert.equal(t.byItem.tee.revenue, 62);                 // 37 + 25
  assert.equal(t.byItem.tee.byVariant['Gildan · Black'], 2);
  assert.equal(t.byItem.tee.byVariant['Bella · Navy'], 1);
  assert.equal(t.byItem.hat.revenue, 36);
});

test('tally: an un-priced (legacy) drop has revenue 0 — unchanged behavior', () => {
  const t = _tally([{ name: 'A', itemId: 'x', size: 'M', qty: 5 }]);
  assert.equal(t.revenue, 0);
  assert.equal(t.byItem.x.revenue, 0);
});
