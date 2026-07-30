// Tiered blank options — the math behind the Quoter's apparel blank picker.
//
// These pin the three rules that come from how the owner actually quotes:
// quote off LIST price (S&S promos are his margin, not the client's), average
// across the sizes that actually sell, and never present a blank that has no
// stock in the client's color. Field reads are deliberately tolerant, so there
// are cases here for missing weight and missing inventory too.

const test = require('node:test');
const assert = require('node:assert');

const {
  DEFAULT_SIZE_WINDOW, canonicalSize, averageListPrice, stockForColor,
  unitWeightOz, saleSpread, assignTiers, pickPerTier, summarizeBlank, qtyOf,
} = require('../blankOptions');

// One S&S-shaped SKU row.
const sku = (o = {}) => ({
  styleID: 39, styleName: '3001C', brandName: 'Bella + Canvas',
  sizeName: 'M', sizeOrder: '3', colorName: 'Black',
  piecePrice: 3.00, customerPrice: 2.40, weight: 0.35, qty: 500,
  ...o,
});

const sizes = ['XS', 'S', 'M', 'L', 'XL', '2XL'];

// A full style: every window size in Black, 2XL priced higher (as it really is).
const fullStyle = (over = {}) => sizes.map((s) => sku({
  sizeName: s,
  piecePrice: s === '2XL' ? 5.00 : 3.00,
  ...over,
}));

// ── Size folding ─────────────────────────────────────────────────────────────

test('vendor size spellings fold to one canonical set', () => {
  assert.strictEqual(canonicalSize('XXL'), '2XL');
  assert.strictEqual(canonicalSize('2X'), '2XL');
  assert.strictEqual(canonicalSize(' 2xl '), '2XL');
  assert.strictEqual(canonicalSize('Med'), 'M');
  assert.strictEqual(canonicalSize('LG'), 'L');
});

// ── Rule 1: quote off LIST, never the owner's price ──────────────────────────

test('the quoted blank cost is the LIST price, not what the owner pays', () => {
  // list 3.00 across five sizes + 5.00 on 2XL -> (3*5 + 5) / 6
  const { avg } = averageListPrice(fullStyle());
  assert.strictEqual(avg, round((3 * 5 + 5) / 6));
  // customerPrice is 2.40 everywhere and must not influence it.
  assert.notStrictEqual(avg, 2.40);
});

test('an S&S promo shows up as the owner\'s spread, and never lowers the quote', () => {
  const skus = fullStyle({ customerPrice: 1.80 });
  const { avg } = averageListPrice(skus);
  const sale = saleSpread(skus, avg);
  assert.strictEqual(sale.known, true);
  assert.strictEqual(sale.ownerAvg, 1.80);
  assert.ok(sale.spread > 0, 'a promo should read as a positive spread the owner keeps');
  assert.strictEqual(avg, round((3 * 5 + 5) / 6), 'the quote must not move because of a promo');
});

// ── Rule 2: average across the sizes that sell ───────────────────────────────

test('averages one price per size, not per SKU row', () => {
  // M in six colors would otherwise drag the average toward M's price.
  const skus = [
    ...fullStyle(),
    ...['Red', 'Navy', 'White', 'Sand', 'Army'].map((c) => sku({ sizeName: 'M', colorName: c, piecePrice: 3.00 })),
  ];
  assert.strictEqual(averageListPrice(skus).avg, round((3 * 5 + 5) / 6));
});

test('2XL being dearer pulls the average up, which is the point', () => {
  const flat = averageListPrice(sizes.map((s) => sku({ sizeName: s, piecePrice: 3.00 }))).avg;
  const real = averageListPrice(fullStyle()).avg;
  assert.ok(real > flat, `${real} should exceed the flat-priced ${flat}`);
});

test('sizes outside the window are ignored', () => {
  const skus = [...fullStyle(), sku({ sizeName: '4XL', piecePrice: 40 })];
  assert.strictEqual(averageListPrice(skus).avg, round((3 * 5 + 5) / 6));
});

test('partial size coverage reports what is missing instead of silently averaging less', () => {
  const skus = fullStyle().filter((s) => s.sizeName !== 'XS' && s.sizeName !== '2XL');
  const r = averageListPrice(skus);
  assert.deepStrictEqual(r.missing, ['XS', '2XL']);
  assert.deepStrictEqual(r.covered, ['S', 'M', 'L', 'XL']);
  assert.strictEqual(r.avg, 3.00);
});

test('a color filter prices only that color', () => {
  const skus = [
    ...fullStyle({ colorName: 'Black' }),
    ...sizes.map((s) => sku({ sizeName: s, colorName: 'Sand', piecePrice: 9.00 })),
  ];
  assert.strictEqual(averageListPrice(skus, { color: 'Sand' }).avg, 9.00);
  assert.strictEqual(averageListPrice(skus, { color: 'Black' }).avg, round((3 * 5 + 5) / 6));
});

test('no readable price returns null rather than zero', () => {
  const r = averageListPrice([sku({ piecePrice: undefined, basePrice: undefined, price: undefined })]);
  assert.strictEqual(r.avg, null);
});

// ── Rule 3: don't quote what isn't there ─────────────────────────────────────

test('a colour short one size in the window is flagged, not quietly passed', () => {
  const skus = fullStyle().map((s) => (s.sizeName === 'XS' ? { ...s, qty: 0 } : s));
  const st = stockForColor(skus, { color: 'Black' });
  assert.strictEqual(st.known, true);
  assert.strictEqual(st.ok, false);
  assert.deepStrictEqual(st.shortSizes, ['XS']);
});

test('a fully stocked colour reads ok with a total', () => {
  const st = stockForColor(fullStyle(), { color: 'Black' });
  assert.strictEqual(st.ok, true);
  assert.strictEqual(st.total, 6 * 500);
});

test('warehouse breakdowns are summed across warehouses', () => {
  assert.strictEqual(qtyOf({ warehouses: [{ qty: 10 }, { qty: 5 }] }), 15);
  assert.strictEqual(qtyOf({ qty: 7 }), 7);
});

test('unreadable inventory reports unknown, never out-of-stock', () => {
  const skus = fullStyle().map(({ qty, ...rest }) => rest);
  const st = stockForColor(skus, { color: 'Black' });
  assert.strictEqual(st.known, false);
  assert.strictEqual(st.ok, null, 'unknown must not read as false — that would hide good blanks');
});

// ── Weight (feeds apparel freight) ───────────────────────────────────────────

test('unit weight comes back in ounces', () => {
  assert.strictEqual(unitWeightOz(fullStyle()), 5.6);   // 0.35 lb -> 5.6 oz
});

test('one mis-keyed weight row cannot drag the figure', () => {
  const skus = fullStyle();
  skus[0] = { ...skus[0], weight: 400 };                // absurd outlier
  assert.ok(unitWeightOz(skus) < 10, 'median should absorb the outlier');
});

test('missing weight is null, not a guess', () => {
  const skus = fullStyle().map(({ weight, ...rest }) => rest);
  assert.strictEqual(unitWeightOz(skus), null);
});

// ── Tiering ──────────────────────────────────────────────────────────────────

test('tiers are terciles of the candidate set, not fixed dollar bands', () => {
  const cands = [2, 3, 4, 8, 9, 10, 20, 21, 22].map((p, i) => ({ style: `S${i}`, blankCost: p }));
  const tiered = assignTiers(cands);
  const of = (p) => tiered.find((c) => c.blankCost === p).tier;
  assert.strictEqual(of(2), 'budget');
  assert.strictEqual(of(9), 'mid');
  assert.strictEqual(of(22), 'premium');
});

test('a hoodie set tiers on its own scale, so nothing is all-premium', () => {
  const hoodies = [18, 20, 24, 30, 34, 40].map((p, i) => ({ style: `H${i}`, blankCost: p }));
  const tiered = assignTiers(hoodies);
  assert.ok(tiered.some((c) => c.tier === 'budget'));
  assert.ok(tiered.some((c) => c.tier === 'premium'));
});

test('unpriced candidates are dropped rather than tiered as free', () => {
  const tiered = assignTiers([{ style: 'A', blankCost: 3 }, { style: 'B', blankCost: null }]);
  assert.strictEqual(tiered.length, 1);
  assert.strictEqual(tiered[0].style, 'A');
});

test('fewer candidates than tiers still returns usable picks', () => {
  const tiered = assignTiers([{ style: 'A', blankCost: 3 }, { style: 'B', blankCost: 9 }]);
  assert.strictEqual(tiered.length, 2);
  assert.ok(tiered.every((c) => c.tier));
});

test('an empty set is safe', () => {
  assert.deepStrictEqual(assignTiers([]), []);
});

test('each tier prefers an in-stock pick but still answers when none is', () => {
  const tiered = assignTiers([
    { style: 'cheap-out', blankCost: 2, stock: { ok: false } },
    { style: 'cheap-in',  blankCost: 3, stock: { ok: true } },
    { style: 'mid',       blankCost: 9, stock: { ok: true } },
    { style: 'prem',      blankCost: 20, stock: { ok: false } },
  ]);
  const picks = pickPerTier(tiered);
  assert.strictEqual(picks.budget.style, 'cheap-in', 'should skip the out-of-stock cheaper one');
  assert.strictEqual(picks.premium.style, 'prem', 'falls back rather than returning nothing');
});

// ── End to end on one style ──────────────────────────────────────────────────

test('summarizeBlank returns everything a quote line needs', () => {
  const s = summarizeBlank(
    { styleID: 39, style: '3001C', brand: 'Bella + Canvas', title: 'Bella + Canvas Jersey Tee' },
    fullStyle(),
    { color: 'Black' },
  );
  assert.strictEqual(s.styleID, 39);
  assert.strictEqual(s.brand, 'Bella + Canvas');
  assert.strictEqual(s.blankCost, round((3 * 5 + 5) / 6));
  assert.strictEqual(s.unitWeightOz, 5.6);
  assert.strictEqual(s.stock.ok, true);
  assert.deepStrictEqual(s.sizeWindow, DEFAULT_SIZE_WINDOW);
  assert.strictEqual(s.perSize['2XL'], 5.00);
  assert.ok(s.sale.spread > 0);
});

test('summarizeBlank survives a style S&S gave us almost nothing for', () => {
  const s = summarizeBlank({ styleID: 1, style: 'X', brand: 'B', title: 'T' }, [{ sizeName: 'M' }], {});
  assert.strictEqual(s.blankCost, null);
  assert.strictEqual(s.unitWeightOz, null);
  assert.strictEqual(s.stock.known, false);
  assert.strictEqual(s.sale.known, false);
});

function round(n) { return Math.round(n * 100) / 100; }
