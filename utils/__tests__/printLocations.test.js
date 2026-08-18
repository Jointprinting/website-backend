const test = require('node:test');
const assert = require('node:assert');
const { realLocations, methodsOf, summarizeType, summarizeDetails, flatFieldsFor } = require('../printLocations');

// The owner's case: "if a garment has screen print and DTG that doesn't let me."
const MIXED = [
  { location: 'Front', method: 'Screen Print', details: '3 color' },
  { location: 'Back',  method: 'DTG',          details: '12x16' },
];

test('a screen front and a DTG back describe themselves in one line', () => {
  assert.deepStrictEqual(flatFieldsFor(MIXED), {
    printType: 'Screen Print + DTG',
    printDetails: 'Front: Screen Print 3 color · Back: DTG 12x16',
  });
});

test('one method reads exactly as the single field always did', () => {
  assert.strictEqual(summarizeType([{ location: 'Front', method: 'Screen Print', details: '3 color' }]), 'Screen Print');
});

test('a method used twice is named once', () => {
  assert.deepStrictEqual(methodsOf([
    { location: 'Front', method: 'Screen Print' },
    { location: 'Back',  method: 'screen print' },
    { location: 'Sleeve', method: 'Embroidery' },
  ]), ['Screen Print', 'Embroidery']);
});

test('three placements all survive into the detail', () => {
  assert.strictEqual(summarizeDetails([
    { location: 'Front', method: 'Screen Print', details: '3 color' },
    { location: 'Back', method: 'Screen Print', details: '1 color' },
    { location: 'Left sleeve', method: 'Embroidery', details: '8,000 stitches' },
  ]), 'Front: Screen Print 3 color · Back: Screen Print 1 color · Left sleeve: Embroidery 8,000 stitches');
});

test('an empty row the owner added and never filled changes nothing', () => {
  assert.deepStrictEqual(flatFieldsFor([{ location: '', method: '', details: '' }]), {});
  assert.deepStrictEqual(realLocations([{ location: '  ', method: '' }]), []);
});

test('no locations at all leaves the hand-typed fields alone', () => {
  // Every existing confirmation item takes this path: the patch is empty, so
  // whatever the owner typed into printType/printDetails stands untouched.
  assert.deepStrictEqual(flatFieldsFor([]), {});
  assert.deepStrictEqual(flatFieldsFor(null), {});
  assert.deepStrictEqual(flatFieldsFor(undefined), {});
});

test('partial rows still say what they can', () => {
  assert.strictEqual(summarizeDetails([{ location: 'Front' }]), 'Front');
  assert.strictEqual(summarizeDetails([{ method: 'DTG', details: '12x16' }]), 'DTG 12x16');
  assert.strictEqual(summarizeType([{ location: 'Front' }]), '', 'a placement with no method names no method');
});

test('junk never throws', () => {
  assert.deepStrictEqual(methodsOf(null), []);
  assert.deepStrictEqual(realLocations(null), []);
  assert.strictEqual(summarizeType(null), '');
  assert.strictEqual(summarizeDetails(null), '');
  assert.deepStrictEqual(realLocations([null, undefined]), []);
});
