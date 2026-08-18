const test = require('node:test');
const assert = require('node:assert');
const { splitTotal, orderedQty, tierLineFor, minRunFor, validateSplit, runKey, runLines } = require('../colorSplit');

// The owner's rule: a run is defined by its INK, not the garment. Same ink →
// the quantities combine and buy a better tier. Different ink → two runs that
// can never combine, however similar the garments look.
const RUN = [
  { group: 'Tees', lid: 'a', styleCode: 'G500', description: 'Heavy Tee', printDetails: 'black ink', qty: 50,  unitPrice: 12 },
  { group: 'Tees', lid: 'b', styleCode: 'G500', description: 'Heavy Tee', printDetails: 'black ink', qty: 150, unitPrice: 9 },
  { group: 'Tees', lid: 'c', styleCode: 'G500', description: 'Heavy Tee', printDetails: 'black ink', qty: 300, unitPrice: 8 },
];
const OFFERED = [
  { name: 'Maroon', code: 'MAR', hex: '#7b1f2b' },
  { name: 'White',  code: 'WHT', hex: '#ffffff' },
  { name: 'Sand',   code: 'SND', hex: '#d8cbb4' },
];

test("the owner's example: 75 maroon + 75 white on one ink buys the 150 tier", () => {
  const r = validateSplit(OFFERED, [{ name: 'Maroon', qty: 75 }, { name: 'White', qty: 75 }], RUN);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.total, 150);
  assert.strictEqual(tierLineFor(RUN, r.total).unitPrice, 9, 'combined, so the 150 price — not two 75s at the 50 price');
});

test('three colours at 150 each is 450 units — the case chips could never express', () => {
  const r = validateSplit(OFFERED, [
    { name: 'Maroon', qty: 150 }, { name: 'White', qty: 150 }, { name: 'Sand', qty: 150 },
  ], RUN);
  assert.strictEqual(r.total, 450);
  assert.strictEqual(tierLineFor(RUN, 450).qty, 300, 'floors to the biggest break it reaches');
});

test('a total between breaks pays the lower break, for every unit', () => {
  assert.strictEqual(tierLineFor(RUN, 175).qty, 150);
  assert.strictEqual(tierLineFor(RUN, 299).qty, 150);
  assert.strictEqual(tierLineFor(RUN, 300).qty, 300);
});

test('below the smallest run there is no tier — say the minimum, do not sell under it', () => {
  assert.strictEqual(tierLineFor(RUN, 20), null);
  assert.strictEqual(minRunFor(RUN), 50);
  const r = validateSplit(OFFERED, [{ name: 'Maroon', qty: 20 }], RUN);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /runs from 50 pieces/);
  assert.match(r.message, /Add 30 more/);
});

test('ordered quantity is the split total, so a 450 split billed off the 300 tier bills 450', () => {
  const tier = { qty: 300, colorSplit: [{ name: 'Maroon', qty: 150 }, { name: 'White', qty: 300 }] };
  assert.strictEqual(orderedQty(tier), 450);
  // …and a line with no split is untouched: every existing quote reads as before.
  assert.strictEqual(orderedQty({ qty: 150 }), 150);
  assert.strictEqual(orderedQty({ qty: 150, colorSplit: [] }), 150);
  assert.strictEqual(orderedQty(null), 0);
});

test('a colour nobody offered is refused — the offer was stock-checked, anything else was not', () => {
  const r = validateSplit(OFFERED, [{ name: 'Kiwi', qty: 100 }], RUN);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /don't have "Kiwi"/);
});

test('colour names snap to the owner spelling, and codes work as the id', () => {
  const r = validateSplit(OFFERED, [{ name: '  maROON ', qty: 60 }, { code: 'wht', qty: 90 }], RUN);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.split.map(c => c.name), ['Maroon', 'White']);
  assert.strictEqual(r.split[0].hex, '#7b1f2b', 'swatch comes from the offer, never the client');
});

test('zero-quantity colours drop out rather than counting as a pick', () => {
  const r = validateSplit(OFFERED, [{ name: 'Maroon', qty: 150 }, { name: 'Sand', qty: 0 }], RUN);
  assert.strictEqual(r.total, 150);
  assert.deepStrictEqual(r.split.map(c => c.name), ['Maroon']);
});

test('one colour listed twice is refused rather than silently summed', () => {
  const r = validateSplit(OFFERED, [{ name: 'Maroon', qty: 75 }, { name: 'maroon', qty: 75 }], RUN);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /listed twice/);
});

test('an empty or all-zero allocation asks for quantities instead of accepting nothing', () => {
  assert.match(validateSplit(OFFERED, [], RUN).message, /how many of each/);
  assert.match(validateSplit(OFFERED, [{ name: 'Maroon', qty: 0 }], RUN).message, /how many of each/);
});

test('different ink is a different run — the two never share a tier table', () => {
  const whiteInk = { group: 'Tees', styleCode: 'G500', description: 'Heavy Tee', printDetails: 'white ink', qty: 50 };
  assert.notStrictEqual(runKey(RUN[0]), runKey(whiteInk));
  const view = [...RUN, whiteInk];
  assert.strictEqual(runLines(view, RUN[0]).length, 3, 'the black-ink run keeps its own three breaks');
  assert.strictEqual(runLines(view, whiteInk).length, 1);
});

test('a run in another GROUP never merges, even with identical everything else', () => {
  const other = { ...RUN[0], group: 'Second design' };
  assert.strictEqual(runLines([...RUN, other], RUN[0]).length, 3);
});

test('splitTotal and the helpers are safe on junk', () => {
  assert.strictEqual(splitTotal(null), 0);
  assert.strictEqual(splitTotal([{ qty: 'x' }, { qty: -5 }]), 0);
  assert.strictEqual(tierLineFor([], 100), null);
  assert.strictEqual(tierLineFor(null, 100), null);
  assert.strictEqual(minRunFor(null), 0);
  assert.strictEqual(validateSplit(null, null, null).ok, false);
});
