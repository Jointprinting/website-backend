// Turning a drop's commitments into confirmation items.
//
// A preorder collects one row per PERSON — "Nathan, Hoodie, Black, L, ×1". What
// a printer and a client read is one line per product/colour with a size run
// under it. Doing that by hand at the exact moment the drop goes live is how a
// size gets miscounted, and a miscount here becomes an invoice and a print run.

const test = require('node:test');
const assert = require('node:assert');

const { rollupCommitments, mergeSizes, lineLabel } = require('../preorderRollup');

const link = (commitments, items = [{ id: 'h', label: 'Hoodie' }, { id: 't', label: 'Tee' }]) =>
  ({ items, commitments });

const c = (over = {}) => ({ name: 'Someone', itemId: 'h', size: 'L', qty: 1, unitPrice: 45, ...over });

test('people ordering the same thing in different sizes are ONE line', () => {
  const { items } = rollupCommitments(link([
    c({ name: 'Nathan', size: 'L' }),
    c({ name: 'Sam', size: 'M' }),
    c({ name: 'Alex', size: 'L' }),
  ]));
  assert.strictEqual(items.length, 1, 'one product line, not three');
  const sizes = Object.fromEntries(items[0].sizes.map((s) => [s.label, s.qty]));
  assert.deepStrictEqual(sizes, { L: 2, M: 1 });
});

test('a repeated size is MERGED, never repeated', () => {
  // Repeated labels silently double a line's revenue — the totals math reads
  // qty × unitPrice per row.
  const { items } = rollupCommitments(link([c({ size: 'L', qty: 2 }), c({ size: 'L', qty: 3 })]));
  assert.strictEqual(items[0].sizes.length, 1);
  assert.strictEqual(items[0].sizes[0].qty, 5);
});

test('different colours are different lines — they print separately', () => {
  const { items } = rollupCommitments(link([
    c({ color: 'Black' }), c({ color: 'White' }), c({ color: 'Black', size: 'M' }),
  ]));
  assert.strictEqual(items.length, 2);
  const black = items.find((i) => i.color === 'Black');
  assert.strictEqual(black.sizes.reduce((n, s) => n + s.qty, 0), 2);
});

test('different products are different lines', () => {
  const { items } = rollupCommitments(link([c({ itemId: 'h' }), c({ itemId: 't' })]));
  assert.strictEqual(items.length, 2);
});

test('the line is labelled from the drop catalog, with variant and colour', () => {
  const { items } = rollupCommitments(link([c({ variant: 'Independent', color: 'Black' })]));
  assert.strictEqual(items[0].productName, 'Hoodie · Independent · Black');
});

test('a promo item with no size gets one OS row, not a blank label', () => {
  const { items } = rollupCommitments(link([c({ itemId: 't', size: '', qty: 100 })],
    [{ id: 't', label: 'Lighters' }]));
  assert.deepStrictEqual(items[0].sizes, [{ label: 'OS', qty: 100, unitPrice: 45 }]);
});

test('the price the committer was quoted rides along', () => {
  const { items } = rollupCommitments(link([c({ unitPrice: 38.5 })]));
  assert.strictEqual(items[0].sizes[0].unitPrice, 38.5);
});

test('a later $0 row does not wipe a price already captured', () => {
  const { items } = rollupCommitments(link([c({ size: 'L', unitPrice: 45 }), c({ size: 'L', unitPrice: 0 })]));
  assert.strictEqual(items[0].sizes[0].unitPrice, 45);
  assert.strictEqual(items[0].sizes[0].qty, 2);
});

test('zero and negative quantities are SKIPPED and reported, never silently dropped', () => {
  // A vanished order is how someone turns up on pickup day expecting a shirt
  // that was never made.
  const out = rollupCommitments(link([c(), c({ qty: 0 }), c({ qty: -3 }), null]));
  assert.strictEqual(out.skipped, 3);
  assert.strictEqual(out.units, 1);
});

test('the totals are the numbers he would otherwise count by hand', () => {
  const out = rollupCommitments(link([
    c({ name: 'Nathan', size: 'L', qty: 2 }),
    c({ name: 'Sam', size: 'M', qty: 1 }),
    c({ name: 'Alex', itemId: 't', size: 'S', qty: 3 }),
  ]));
  assert.strictEqual(out.units, 6);
  assert.strictEqual(out.people, 3);
});

test('the same person ordering twice counts once as a person', () => {
  const out = rollupCommitments(link([c({ name: 'Nathan' }), c({ name: 'nathan ', size: 'M' })]));
  assert.strictEqual(out.people, 1);
  assert.strictEqual(out.units, 2);
});

test('the biggest line sorts first — the one worth checking before sending', () => {
  const { items } = rollupCommitments(link([
    c({ itemId: 't', qty: 1 }),
    c({ itemId: 'h', qty: 40 }),
  ]));
  assert.strictEqual(items[0].productName, 'Hoodie');
});

test('an unknown itemId still produces a line rather than losing the order', () => {
  const { items } = rollupCommitments(link([c({ itemId: 'ghost' })]));
  assert.strictEqual(items.length, 1);
  assert.ok(items[0].productName.includes('ghost'));
});

test('handles an empty or missing drop', () => {
  assert.deepStrictEqual(rollupCommitments(link([])), { items: [], units: 0, people: 0, skipped: 0 });
  assert.deepStrictEqual(rollupCommitments(null), { items: [], units: 0, people: 0, skipped: 0 });
});

test('mergeSizes and lineLabel are usable on their own', () => {
  assert.deepStrictEqual(mergeSizes([{ size: 'S', qty: 1, unitPrice: 10 }, { size: 'S', qty: 2 }]),
    [{ label: 'S', qty: 3, unitPrice: 10 }]);
  assert.strictEqual(lineLabel('Hoodie', '', 'Black'), 'Hoodie · Black');
});

// ── The rolled-up item has to fit where it is going ──────────────────────────
//
// This file used to assert `description`, and so did the code — but
// Order.confirmation.items has no `description` path, and Mongoose strict mode
// drops an undeclared field silently. The tests passed while every rolled-in
// drop line lost its name on save and reached the client's confirmation, and the
// printer's PO, as "Item 1 · Black".
//
// A test that pins a shape the destination never accepted is worse than no test,
// so this one asks the schema instead of asserting a name.
test('every field a rolled-up item carries actually exists on a confirmation item', () => {
  const Order = require('../../models/Order');
  const allowed = new Set(Object.keys(Order.schema.path('confirmation.items').schema.paths));

  const { items } = rollupCommitments({
    items: [{ id: 'i1', label: 'Hoodie', sizes: ['M', 'L'] }],
    commitments: [
      { name: 'Nathan', itemId: 'i1', variant: 'Independent', color: 'Black', size: 'L', qty: 1, unitPrice: 42 },
      { name: 'Rita',   itemId: 'i1', variant: 'Independent', color: 'Black', size: 'M', qty: 2, unitPrice: 42 },
    ],
  });

  assert.ok(items.length > 0);
  for (const it of items) {
    for (const key of Object.keys(it)) {
      assert.ok(allowed.has(key), `confirmation.items has no "${key}" path — strict mode would drop it`);
    }
  }
});

test('the product name survives onto the item the client will read', () => {
  const { items } = rollupCommitments({
    items: [{ id: 'i1', label: 'Hoodie', sizes: ['L'] }],
    commitments: [{ name: 'Nathan', itemId: 'i1', variant: 'Independent', color: 'Black', size: 'L', qty: 1, unitPrice: 42 }],
  });
  // productName is what ConfirmationDocument reads first:
  //   productName || brandName || styleCode || `Item ${idx + 1}`
  assert.strictEqual(items[0].productName, 'Hoodie · Independent · Black');
  assert.notStrictEqual(items[0].productName, undefined, 'without this the line renders as "Item 1"');
});
