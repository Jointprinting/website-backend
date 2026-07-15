// utils/__tests__/mockupNumbers.test.js
//   node --test utils/__tests__/mockupNumbers.test.js
// The Mockup Lab numbering engine — colours = letters (A→Z→AA overflow),
// edits = trailing version (#150A → #150A2). Owner's spec, 2026-07.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  letterToNum, numToLetter, baseForProject,
  parseMockupNum, formatMockupNum, nextColorLetter, nextEditVersion,
} = require('../mockupNumbers');

test('letterToNum / numToLetter are inverse, bijective base-26', () => {
  const cases = [[1, 'A'], [2, 'B'], [26, 'Z'], [27, 'AA'], [28, 'AB'], [52, 'AZ'], [53, 'BA'], [702, 'ZZ'], [703, 'AAA']];
  for (const [n, s] of cases) {
    assert.equal(numToLetter(n), s, `numToLetter(${n})`);
    assert.equal(letterToNum(s), n, `letterToNum(${s})`);
  }
  // round-trips
  for (let n = 1; n <= 800; n++) assert.equal(letterToNum(numToLetter(n)), n);
});

test('letterToNum rejects non-letters', () => {
  assert.equal(letterToNum('A1'), 0);
  assert.equal(letterToNum(''), 0);
  assert.equal(letterToNum('#'), 0);
});

test('baseForProject pads to 6 and drops any -suffix', () => {
  assert.equal(baseForProject('150'), '#000150');
  assert.equal(baseForProject('150-2'), '#000150');
  assert.equal(baseForProject(148), '#000148');
  assert.equal(baseForProject(''), '');
  assert.equal(baseForProject('abc'), '');
});

test('parseMockupNum splits base / colour / edit-version', () => {
  assert.deepEqual(parseMockupNum('#000150A'), { base: '#000150', digits: '000150', letter: 'A', letterNum: 1, version: 1 });
  assert.deepEqual(parseMockupNum('#000150B'), { base: '#000150', digits: '000150', letter: 'B', letterNum: 2, version: 1 });
  assert.deepEqual(parseMockupNum('#000150A2'), { base: '#000150', digits: '000150', letter: 'A', letterNum: 1, version: 2 });
  assert.deepEqual(parseMockupNum('#000150AA'), { base: '#000150', digits: '000150', letter: 'AA', letterNum: 27, version: 1 });
  assert.deepEqual(parseMockupNum('#000150AB3'), { base: '#000150', digits: '000150', letter: 'AB', letterNum: 28, version: 3 });
  // tolerant of a missing #, lowercase
  assert.equal(parseMockupNum('150a2').letter, 'A');
  assert.equal(parseMockupNum('150a2').version, 2);
});

test('parseMockupNum rejects junk', () => {
  assert.equal(parseMockupNum(''), null);
  assert.equal(parseMockupNum('#000150'), null);   // no colour letter
  assert.equal(parseMockupNum('promo-shot'), null);
  assert.equal(parseMockupNum(null), null);
});

test('formatMockupNum omits the version for the original (v1), adds it from v2', () => {
  assert.equal(formatMockupNum('#000150', 'A', 1), '#000150A');
  assert.equal(formatMockupNum('#000150', 'A'), '#000150A');       // default v1
  assert.equal(formatMockupNum('#000150', 'A', 2), '#000150A2');
  assert.equal(formatMockupNum('000150', 'a', 3), '#000150A3');    // adds #, upper
  assert.equal(formatMockupNum('#000150', 'AA', 1), '#000150AA');
});

test('nextColorLetter walks A→B→C and overflows Z→AA→AB', () => {
  assert.equal(nextColorLetter('150', []), '#000150A');
  assert.equal(nextColorLetter('150', ['#000150A']), '#000150B');
  assert.equal(nextColorLetter('150', ['#000150A', '#000150B']), '#000150C');
  // edits don't consume a colour — A2 present, next colour is still B
  assert.equal(nextColorLetter('150', ['#000150A', '#000150A2']), '#000150B');
  // 26 colours present → 27th overflows to AA
  const az = Array.from({ length: 26 }, (_, i) => `#000150${numToLetter(i + 1)}`);
  assert.equal(nextColorLetter('150', az), '#000150AA');
  assert.equal(nextColorLetter('150', [...az, '#000150AA']), '#000150AB');
  // ignores other projects / promo junk in the list
  assert.equal(nextColorLetter('150', ['#000150A', '#000149Z', 'promo']), '#000150B');
});

test('nextEditVersion bumps the trailing number for one colour lane', () => {
  // first edit of the original A → A2
  assert.equal(nextEditVersion('#000150A', ['#000150A']), '#000150A2');
  // next edit → A3
  assert.equal(nextEditVersion('#000150A', ['#000150A', '#000150A2']), '#000150A3');
  // editing from any node in the lane still finds the max
  assert.equal(nextEditVersion('#000150A2', ['#000150A', '#000150A2', '#000150A3']), '#000150A4');
  // colour B's versions are independent of A's
  assert.equal(nextEditVersion('#000150B', ['#000150A', '#000150A2', '#000150A3', '#000150B']), '#000150B2');
  // overflow-letter lane
  assert.equal(nextEditVersion('#000150AA', ['#000150AA']), '#000150AA2');
  // junk source
  assert.equal(nextEditVersion('promo', ['#000150A']), '');
});
