const test = require('node:test');
const assert = require('node:assert');
const { splitTotal, orderedQty, tierLineFor, minRunFor, validateSplit, validateQty, runKey, runLines } = require('../colorSplit');

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

// ── A FREE QUANTITY on a run that is not sold by colour ──────────────────────
//
// The owner's first complaint about the quoter, verbatim: "when I show tiers 50
// 100 150 and they only need 75 units (at 50 unit cost) they can't select that
// ... I don't want them to have to ask me to make the change, it adds friction."
//
// The engine already existed and was already proven by the colour split — it
// was simply unreachable unless the line carried a live S&S colour lookup. These
// pin the colour-less path, and they MIRROR
// website-frontend/src/common/colorSplit.test.js: the client page computes the
// price from these rules and this file re-derives it on submit, so a divergence
// would quote a number we then don't honour.

const TIERS = [{ qty: 50, unitPrice: 12 }, { qty: 100, unitPrice: 10 }, { qty: 150, unitPrice: 9 }];

test('75 on a 50/100/150 quote is a valid order, billed at the 50-piece price', () => {
  assert.deepEqual(validateQty(75, TIERS), { ok: true, qty: 75, message: '' });
  assert.equal(tierLineFor(TIERS, 75).qty, 50);
  assert.equal(tierLineFor(TIERS, 75).unitPrice, 12);
});

test('landing exactly on a break takes that break', () => {
  assert.equal(tierLineFor(TIERS, 100).qty, 100);
});

test('above the largest break there is no ceiling — it stays on the largest', () => {
  // Quoting past the top break is the owner's problem to price, not the
  // client's to be blocked on.
  assert.equal(validateQty(500, TIERS).ok, true);
  assert.equal(tierLineFor(TIERS, 500).qty, 150);
});

test('below the MOQ it says how many more, never a bare rejection', () => {
  const r = validateQty(20, TIERS);
  assert.equal(r.ok, false);
  assert.match(r.message, /50 pieces/);
  assert.match(r.message, /30 more/);
});

test('junk and fractions are refused', () => {
  for (const bad of ['', 0, -5, 'abc', null, undefined, NaN]) {
    assert.equal(validateQty(bad, TIERS).ok, false, `${String(bad)} should be refused`);
  }
  assert.match(validateQty(75.5, TIERS).message, /whole number/);
});

test('orderedQty bills what they ordered, not the tier the line priced at', () => {
  assert.equal(orderedQty({ qty: 50, pickedQty: 75 }), 75);
  assert.equal(orderedQty({ qty: 50 }), 50);
  assert.equal(orderedQty({ qty: 50, pickedQty: 0 }), 50);
  // A colour split still wins — the two are never both set.
  assert.equal(orderedQty({ qty: 50, pickedQty: 75, colorSplit: [{ name: 'Black', qty: 200 }] }), 200);
});

test('a typed quantity flows into the quote totals, so the order bills 75 not 50', () => {
  // The whole point, at the money layer: this is what computeQuoteTotals sums.
  const { computeQuoteTotals } = require('../../models/Order');
  const line = { group: 'Tees', accepted: true, qty: 50, pickedQty: 75, unitPrice: 12, blankCost: 4, printCost: 3 };
  const t = computeQuoteTotals([line], 0, 0);
  assert.equal(t.totalValue, 900);           // 75 × 12, not 50 × 12
  assert.equal(t.cogs, 525);                 // 75 × (4 + 3)
});
