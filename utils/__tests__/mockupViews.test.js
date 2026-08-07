// utils/__tests__/mockupViews.test.js
//   node --test utils/__tests__/mockupViews.test.js
//
// Every image of one mockup, in reading order — the list the builder preview,
// the approval page and the confirmation PDF all render from.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mockupViewList, extraPageViews } = require('../mockupViews');

test('a single-page mockup is front then back', () => {
  assert.deepEqual(
    mockupViewList({ front: 'F', back: 'B' }),
    ['F', 'B'],
  );
});

test('reads a raw library document too (thumbnail/data)', () => {
  // The approval payload renames these; a PDF entry does not. Both shapes in.
  assert.deepEqual(
    mockupViewList({ thumbnail: 'F', data: 'B' }),
    ['F', 'B'],
  );
});

test('extra pages read front, back, front, back — page by page', () => {
  assert.deepEqual(
    mockupViewList({
      front: 'F1', back: 'B1',
      extraViews: ['F2', 'F3'],
      extraBackViews: ['B2', 'B3'],
    }),
    ['F1', 'B1', 'F2', 'B2', 'F3', 'B3'],
  );
});

test('includeBack:false drops EVERY back, not just page 1s', () => {
  // A confirmation item without showBack must not sneak an extra page's blank
  // garment back onto the client's document through the side door.
  assert.deepEqual(
    mockupViewList(
      { front: 'F1', back: 'B1', extraViews: ['F2'], extraBackViews: ['B2'] },
      { includeBack: false },
    ),
    ['F1', 'F2'],
  );
});

test('misaligned arrays are never paired — fronts first, then the backs', () => {
  // extraViews is stored compacted (.filter(Boolean)) and extraBackViews padded
  // with '', so unequal lengths mean we cannot know which back is whose. Showing
  // them unpaired loses nothing; pairing them would put page 3's back under
  // page 2's front.
  assert.deepEqual(
    mockupViewList({
      front: 'F1', back: 'B1',
      extraViews: ['F3'],            // page 2 had no front composite, dropped
      extraBackViews: ['', 'B3'],    // …but its slot survives here
    }),
    ['F1', 'B1', 'F3', 'B3'],
  );
});

test('empty back placeholders never become blank tiles', () => {
  assert.deepEqual(
    mockupViewList({
      front: 'F1', back: '',
      extraViews: ['F2', 'F3'],
      extraBackViews: ['', 'B3'],
    }),
    ['F1', 'F2', 'F3', 'B3'],
  );
});

test('a legacy doc with no extraBackViews is exactly what it was before', () => {
  assert.deepEqual(
    mockupViewList({ front: 'F1', back: 'B1', extraViews: ['F2', 'F3'] }),
    ['F1', 'B1', 'F2', 'F3'],
  );
});

test('handles missing, null and empty input', () => {
  assert.deepEqual(mockupViewList(null), []);
  assert.deepEqual(mockupViewList({}), []);
  assert.deepEqual(mockupViewList({ front: 'F', extraViews: null, extraBackViews: null }), ['F']);
  assert.deepEqual(extraPageViews(null, null, true), []);
  assert.deepEqual(extraPageViews(undefined, ['B2'], true), ['B2']);
});

test('front-only pages keep their order when a back is missing mid-run', () => {
  assert.deepEqual(
    extraPageViews(['F2', 'F3', 'F4'], ['B2', '', 'B4'], true),
    ['F2', 'B2', 'F3', 'F4', 'B4'],
  );
});
