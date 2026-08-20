// controllers/__tests__/duplicateOrder.test.js
//
//   node --test controllers/__tests__/duplicateOrder.test.js
//
// A reorder is supposed to be the same offer again. It wasn't: the quote-line
// copy is an allow-list, and four fields were missing from it, so every repeat
// job came back quietly degraded.
//
// The worst of the four is hiddenFromClient — an owner-parked internal costing
// line came back VISIBLE, so a reorder put the owner's own working numbers on a
// client's approval page. The rest are regressions: without colorOptions the
// client loses the colour split and with it the ability to land between price
// breaks, which means the reorder is a WORSE offer than the original.
//
// And mockupNum needs the opposite treatment from all of them — see below.

const test = require('node:test');
const assert = require('node:assert/strict');

const { duplicateQuoteLine, remapCarriedMockups } = require('../orders');

const SOURCE = {
  lid: 'abc123', group: 'Tees', qty: 100, styleCode: 'G500', description: 'Heavy Tee',
  color: '', supplier: 'S&S', supplierUrl: 'https://ssactivewear.com/p/g500',
  blankCost: 3.2, blankWeightOz: 6.1, printType: 'Screen print', printDetails: '3c front',
  printCost: 4.55, printerKey: 'heritage', printerName: 'Heritage', printSpec: { areas: [] },
  setupCost: 120, shippingCost: 90, markup: 1.4, noMarkup: false, unitPrice: 12.92,
  turnaroundWeeks: 2, catalogUnitPrice: 0, priceLocked: false,
  colorOptions: [{ name: 'Maroon', code: 'MAR', hex: '#7b1f2b', image: 'https://x/m.jpg' }],
  hiddenFromClient: true, image: 'data:image/png;base64,AAAA', mockupNum: '000150A',
  // The client's answers on the ORIGINAL order — none of these may come across.
  accepted: true, colorSplit: [{ name: 'Maroon', qty: 75 }], pickedQty: 75,
};

test('the offer carries: the colours, the parked flag and the render all survive', () => {
  const out = duplicateQuoteLine(SOURCE);
  assert.deepEqual(out.colorOptions, [{ name: 'Maroon', code: 'MAR', hex: '#7b1f2b', image: 'https://x/m.jpg' }]);
  assert.equal(out.hiddenFromClient, true, 'a parked line must not come back visible to a client');
  assert.equal(out.image, 'data:image/png;base64,AAAA');
});

test("the client's answers do not carry — a fresh quote is not pre-picked", () => {
  const out = duplicateQuoteLine(SOURCE);
  for (const k of ['accepted', 'colorSplit', 'pickedQty', 'lid']) {
    assert.equal(k in out, false, `${k} belongs to the order that was actually sold`);
  }
});

test('the pricing recipe carries in full', () => {
  const out = duplicateQuoteLine(SOURCE);
  for (const k of ['qty', 'styleCode', 'description', 'blankCost', 'printCost', 'printerKey',
                   'printSpec', 'setupCost', 'shippingCost', 'markup', 'unitPrice',
                   'turnaroundWeeks', 'priceLocked']) {
    assert.deepEqual(out[k], SOURCE[k], `${k} should be copied verbatim`);
  }
});

test('an empty line copies without throwing', () => {
  const out = duplicateQuoteLine({});
  assert.deepEqual(out.colorOptions, []);
  assert.equal(out.hiddenFromClient, false);
  assert.equal(out.image, '');
  assert.equal(out.mockupNum, '');
});

// ── mockupNum: the one field that must NOT be copied verbatim ────────────────
test('a carried design is re-pointed at the number the new project owns', () => {
  // carryMockups CLONES and RE-LETTERS: #000150A becomes #000200A under the new
  // project. Keeping the old number would leave the new quote pointing at the
  // finished job's designs.
  const lines = [{ mockupNum: '000150A' }, { mockupNum: '000150B' }];
  const touched = remapCarriedMockups(lines, [
    { from: '000150A', mockupNum: '000200A' },
    { from: '000150B', mockupNum: '000200B' },
  ]);
  assert.equal(touched, 2);
  assert.deepEqual(lines.map(l => l.mockupNum), ['000200A', '000200B']);
});

test("a design that didn't come across is blanked, not left pointing at the old project", () => {
  const lines = [{ mockupNum: '000150A' }, { mockupNum: '000150C' }];
  remapCarriedMockups(lines, [{ from: '000150A', mockupNum: '000200A' }]);
  assert.deepEqual(lines.map(l => l.mockupNum), ['000200A', ''],
    'a line whose design was not carried reads as "no design yet", which is true');
});

test('nothing carried blanks every number', () => {
  // Duplicating WITHOUT "bring the designs" must not leave the new quote
  // claiming the source project's artwork.
  const lines = [{ mockupNum: '000150A' }, { mockupNum: '000150B' }];
  assert.equal(remapCarriedMockups(lines, []), 2);
  assert.deepEqual(lines.map(l => l.mockupNum), ['', '']);
});

test('matching is case- and whitespace-insensitive', () => {
  // Six different prefixes have minted these over time; treat the number as
  // opaque but compare it forgivingly.
  const lines = [{ mockupNum: ' 000150a ' }];
  remapCarriedMockups(lines, [{ from: '000150A', mockupNum: '000200A' }]);
  assert.equal(lines[0].mockupNum, '000200A');
});

test('a line that never had a design is left alone', () => {
  const lines = [{ mockupNum: '' }, {}, null];
  assert.equal(remapCarriedMockups(lines, [{ from: 'x', mockupNum: 'y' }]), 0);
});

test('junk carried payloads never throw', () => {
  assert.equal(remapCarriedMockups(null, null), 0);
  assert.equal(remapCarriedMockups([{ mockupNum: 'A' }], [null, {}, { from: '' }]), 1);
});
