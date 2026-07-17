// controllers/__tests__/printerCatalog.test.js
//
// Pure-logic checks for the app-writable catalog helpers (4B/4D). No DB.
//   node --test controllers/__tests__/printerCatalog.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateSection, capabilitiesFromCatalog, pricedSectionKeys, isPricedSection,
} = require('../../utils/printerCatalog');

test('validateSection accepts a model-tagged price book', () => {
  const r = validateSection('dtg', { model: 'qty_x_size_x_shade', sizes: ['4x4'], tiers: [] });
  assert.equal(r.ok, true);
});

test('validateSection accepts the Heritage legacy priceGrids shape (no model tag)', () => {
  const r = validateSection('screenPrinting', { priceGrids: { darkInkOnLightGarments: { rows: [] } } });
  assert.equal(r.ok, true);
});

test('validateSection rejects a section with no recognized model (would silently not price)', () => {
  const r = validateSection('dtg', { sizes: ['4x4'], tiers: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /model/);
});

test('validateSection rejects an unknown model tag', () => {
  const r = validateSection('dtg', { model: 'qty_x_wishful_thinking', tiers: [] });
  assert.equal(r.ok, false);
});

test('validateSection refuses to treat a reference block as a price book', () => {
  assert.equal(validateSection('meta', { capturedOn: '2026-01-01' }).ok, false);
  assert.equal(validateSection('addOns', {}).ok, false);
});

test('validateSection needs a section key and an object body', () => {
  assert.equal(validateSection('', { model: 'qty_only' }).ok, false);
  assert.equal(validateSection('dtg', null).ok, false);
  assert.equal(validateSection('dtg', [1, 2, 3]).ok, false);
});

test('capabilitiesFromCatalog derives from the priced sections present, canonical + deduped', () => {
  const catalog = {
    meta: { capturedOn: '2026-01-01' },
    printer: { name: 'X' },
    screenPrinting: { priceGrids: { darkInkOnLightGarments: { rows: [] } } },
    dtg: { model: 'qty_x_size_x_shade', tiers: [] },
    dtf: { model: 'gang_qty_x_size', grid: {} },
    addOns: { foilPerPiece: 1 },     // reference block — ignored
  };
  assert.deepEqual(capabilitiesFromCatalog(catalog), ['screen_printing', 'dtg', 'dtf']);
});

test('capabilitiesFromCatalog skips a soft-archived section', () => {
  const catalog = {
    dtg: { model: 'qty_x_size_x_shade', tiers: [] },
    dtf: { model: 'gang_qty_x_size', grid: {} },
    __archived: { dtf: true },
  };
  assert.deepEqual(capabilitiesFromCatalog(catalog), ['dtg']);
  assert.deepEqual(pricedSectionKeys(catalog), ['dtg']);
});

test('capabilitiesFromCatalog is empty (not a crash) for a catalog with no priced sections', () => {
  assert.deepEqual(capabilitiesFromCatalog({ meta: {}, printer: {} }), []);
  assert.deepEqual(capabilitiesFromCatalog(null), []);
});

test('isPricedSection: a non-model non-priceGrids object is not a price book', () => {
  assert.equal(isPricedSection({ notes: 'hi' }), false);
  assert.equal(isPricedSection({ model: 'qty_only', tiers: [] }), true);
});
