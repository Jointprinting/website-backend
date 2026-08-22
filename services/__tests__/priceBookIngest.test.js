// services/__tests__/priceBookIngest.test.js
//   node --test services/__tests__/priceBookIngest.test.js
//
// Reading a printer's price sheet in-app. The AI call itself isn't tested here —
// what IS tested is everything that decides whether a proposal is safe to put in
// front of the owner, because a price book that silently misprices is worse than
// no price book at all.
//
// The failure mode that matters: a model that can't read one cell shifts the
// remaining numbers left to fill the gap. The row still looks plausible, every
// price after the gap is now attributed to the wrong colour count, and nothing
// downstream would ever notice.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildPrompt, parseReply, validate, shapeForSave, SECTIONS, SECTION_SPECS } = require('../priceBookIngest');

// A well-formed screen-printing section, matching the real committed catalogs.
const goodScreen = () => ({
  model: 'qty_x_colors',
  unit: 'per_piece_per_location',
  setup: 'included',
  colorColumns: ['1', '2', '3'],
  tiers: [
    { minQty: 24, label: '24-47', prices: [3.5, 4.5, 5.5] },
    { minQty: 48, label: '48-71', prices: [2.25, 2.75, 3.25] },
  ],
});

test('every section the extractor offers is one the engine has a model for', () => {
  for (const s of SECTIONS) {
    assert.ok(SECTION_SPECS[s].model, `${s} must declare its engine model`);
    assert.ok(SECTION_SPECS[s].describe.includes(SECTION_SPECS[s].model));
  }
});

test('the prompt forbids guessing and demands one price per column', () => {
  const p = buildPrompt('screenPrinting', 'A+ Images');
  assert.match(p, /EXACTLY one number per column/);
  assert.match(p, /never shift the remaining numbers left/);
  assert.match(p, /use null\. Do not infer/);
  assert.match(p, /A\+ Images/, 'the printer is named so the model knows whose sheet it is');
});

test('parseReply: plain JSON, fenced JSON, and JSON wrapped in prose all work', () => {
  assert.deepEqual(parseReply('{"a":1}').value, { a: 1 });
  assert.deepEqual(parseReply('```json\n{"a":1}\n```').value, { a: 1 });
  assert.deepEqual(parseReply('Here you go:\n{"a":1}\nHope that helps').value, { a: 1 });
});

test('parseReply: a reply with no JSON is refused, not guessed at', () => {
  assert.equal(parseReply('I could not read this document.').ok, false);
  assert.equal(parseReply('').ok, false);
  assert.equal(parseReply('{ not json ]').ok, false);
});

test('a clean section validates', () => {
  const v = validate('screenPrinting', goodScreen());
  assert.equal(v.ok, true, v.problems.join('; '));
  assert.equal(v.cells, 6);
  assert.equal(v.nulls, 0);
});

test('THE ONE THAT MATTERS: a short row is caught, not accepted', () => {
  // Three columns, a row with two prices. Accepting this attributes the 2-colour
  // price to 3 colours on every quote that ever uses this tier.
  const bad = goodScreen();
  bad.tiers[0].prices = [3.5, 4.5];
  const v = validate('screenPrinting', bad);
  assert.equal(v.ok, false);
  assert.match(v.problems.join(' '), /has 2 prices but there are 3 columns/);
});

test('a long row is caught too', () => {
  const bad = goodScreen();
  bad.tiers[1].prices = [1, 2, 3, 4];
  assert.equal(validate('screenPrinting', bad).ok, false);
});

test('a blank cell is allowed through as null, and reported', () => {
  const g = goodScreen();
  g.tiers[0].prices = [3.5, null, 5.5];
  const v = validate('screenPrinting', g);
  assert.equal(v.ok, true, 'a gap is fixable by hand — it must not block the import');
  assert.equal(v.nulls, 1);
  assert.match(v.warnings.join(' '), /1 price came back blank/);
});

test('a mostly-unreadable scan warns loudly rather than passing quietly', () => {
  const g = goodScreen();
  g.tiers[0].prices = [null, null, null];
  g.tiers[1].prices = [null, null, 3.25];
  const v = validate('screenPrinting', g);
  assert.match(v.warnings.join(' '), /5 of 6 prices could not be read/);
});

test('a price that is text, or negative, is a problem not a warning', () => {
  const t = goodScreen();
  t.tiers[0].prices = [3.5, '4.50 ea', 5.5];
  assert.equal(validate('screenPrinting', t).ok, false);
  const n = goodScreen();
  n.tiers[1].prices = [-1, 2.75, 3.25];
  assert.equal(validate('screenPrinting', n).ok, false);
});

test('a tier with no usable minQty is caught — the engine picks tiers by it', () => {
  const bad = goodScreen();
  bad.tiers[0].minQty = 'twenty-four';
  assert.equal(validate('screenPrinting', bad).ok, false);
});

test('the wrong engine model for the section is caught', () => {
  const bad = goodScreen();
  bad.model = 'qty_x_stitches';
  assert.match(validate('screenPrinting', bad).problems.join(' '), /must be "qty_x_colors"/);
});

test('"this document has no such pricing" is reported honestly, not as a broken grid', () => {
  const v = validate('embroidery', { model: null, reason: 'this is a screen printing sheet' });
  assert.equal(v.ok, false);
  assert.match(v.problems[0], /no embroidery pricing found — this is a screen printing sheet/);
});

test('an embroidery grid validates against its stitch bands', () => {
  const ok = validate('embroidery', {
    model: 'qty_x_stitches', unit: 'per_piece',
    qtyTiers: [{ label: '1-11', minQty: 1 }],
    stitchBands: ['upto2000', '2001-4000'],
    grid: { '1-11': [6.5, 7.25] },
  });
  assert.equal(ok.ok, true, ok.problems.join('; '));

  const ragged = validate('embroidery', {
    model: 'qty_x_stitches',
    qtyTiers: [{ label: '1-11', minQty: 1 }],
    stitchBands: ['upto2000', '2001-4000', '4001-6000'],
    grid: { '1-11': [6.5, 7.25] },
  });
  assert.equal(ragged.ok, false);
});

test('a DTF grid validates against its size bands', () => {
  const v = validate('dtf', {
    model: 'qty_x_size_sqin',
    qtyTiers: ['1-11', '12-24'],
    sizeBandsSqin: [5, 10],
    grid: { '1-11': [1.2, 1.8], '12-24': [0.95, 1.4] },
  });
  assert.equal(v.ok, true, v.problems.join('; '));
  assert.equal(v.cells, 4);
});

test('an empty grid or missing columns never validates as fine', () => {
  assert.equal(validate('dtf', { model: 'qty_x_size_sqin', qtyTiers: [], sizeBandsSqin: [5], grid: {} }).ok, false);
  assert.equal(validate('screenPrinting', { model: 'qty_x_colors', tiers: [] }).ok, false);
});

test('junk input never throws', () => {
  for (const junk of [null, undefined, 0, '', [], 'nope']) {
    assert.doesNotThrow(() => validate('screenPrinting', junk));
    assert.equal(validate('screenPrinting', junk).ok, false);
  }
  assert.equal(validate('nonsense-section', goodScreen()).ok, false);
});

test('the model notes are surfaced to the owner as warnings, not swallowed', () => {
  const g = goodScreen();
  g._notes = ['the 6-colour column was cut off in the scan', '  '];
  const v = validate('screenPrinting', g);
  assert.ok(v.warnings.includes('the 6-colour column was cut off in the scan'));
  assert.equal(v.warnings.filter((w) => !w.trim()).length, 0, 'blank notes are dropped');
});

test('shapeForSave strips transport fields and stamps provenance', () => {
  const out = shapeForSave({ ...goodScreen(), _notes: ['x'], reason: 'y' }, { capturedOn: '2026-08-22', source: 'A+ price list' });
  assert.equal(out._notes, undefined);
  assert.equal(out.reason, undefined);
  assert.equal(out.capturedOn, '2026-08-22');
  assert.equal(out.source, 'A+ price list');
  assert.equal(out.model, 'qty_x_colors', 'the actual pricing data is untouched');
  assert.deepEqual(out.tiers, goodScreen().tiers);
});

test('shapeForSave dates the capture even when nothing is passed', () => {
  assert.match(shapeForSave(goodScreen()).capturedOn, /^\d{4}-\d{2}-\d{2}$/);
});
