// What a client sees on a pre-confirmation approval link.
//
// A mockup number carries design → colour → edit version, so #000150A and
// #000150B are two colourways of one design while #000150A2 is the second EDIT
// of colour A. Shown flat, four colourways after a couple of revision rounds
// become ten tiles — several of them proofs the client has already been talked
// out of. Collapsing each colour to its latest edit is what the numbering was
// designed to make possible.

const test = require('node:test');
const assert = require('node:assert');

const { _latestPerColour } = require('../approval');

test('collapses a colour lane to its latest edit', () => {
  assert.deepStrictEqual(
    _latestPerColour(['#000150A', '#000150A2', '#000150A3']),
    ['#000150A3'],
  );
});

test('keeps every colour — colours are different designs, not revisions', () => {
  assert.deepStrictEqual(
    _latestPerColour(['#000150A', '#000150B', '#000150C']),
    ['#000150A', '#000150B', '#000150C'],
  );
});

test('the real shape: colourways with uneven revision histories', () => {
  const out = _latestPerColour([
    '#000150A', '#000150A2',          // red, revised once
    '#000150B',                        // black, untouched
    '#000150C', '#000150C2', '#000150C3', // white, revised twice
  ]);
  assert.deepStrictEqual(out, ['#000150A2', '#000150B', '#000150C3']);
  assert.strictEqual(out.length, 3, 'three colourways → three tiles, not six');
});

test('orders by design then colour, so the client reads them in sequence', () => {
  const out = _latestPerColour(['#000150C', '#000149A', '#000150A']);
  assert.deepStrictEqual(out, ['#000149A', '#000150A', '#000150C']);
});

test('compares versions numerically, not lexically', () => {
  assert.deepStrictEqual(_latestPerColour(['#000150A2', '#000150A10']), ['#000150A10']);
});

test('separates lanes across different designs', () => {
  // #000149A and #000150A are colour A of two DIFFERENT projects/designs —
  // collapsing them together would hide one entirely.
  assert.deepStrictEqual(
    _latestPerColour(['#000149A', '#000150A']),
    ['#000149A', '#000150A'],
  );
});

test('passes through external promo shots untouched', () => {
  // Nothing can be inferred about an unparseable name, so nothing is dropped.
  const out = _latestPerColour(['#000150A', 'Plastic Grinder', 'Lighter']);
  assert.strictEqual(out.length, 3);
  assert.ok(out.includes('Plastic Grinder'));
  assert.ok(out.includes('Lighter'));
  assert.strictEqual(out[0], '#000150A', 'numbered designs lead');
});

test('handles empty and missing input', () => {
  assert.deepStrictEqual(_latestPerColour([]), []);
  assert.deepStrictEqual(_latestPerColour(null), []);
  assert.deepStrictEqual(_latestPerColour(undefined), []);
});

test('is idempotent', () => {
  const once = _latestPerColour(['#000150A', '#000150A2', '#000150B']);
  assert.deepStrictEqual(_latestPerColour(once), once);
});

test('a single design with no revisions is unchanged', () => {
  assert.deepStrictEqual(_latestPerColour(['#000200A']), ['#000200A']);
});
