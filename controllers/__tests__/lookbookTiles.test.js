// controllers/__tests__/lookbookTiles.test.js
//   node --test controllers/__tests__/lookbookTiles.test.js
// The pure tile-shaping behind resolveTiles: which views ride along, and the
// urlOnly guard that keeps legacy inline-base64 images off the light admin
// autosave path.

const test = require('node:test');
const assert = require('node:assert/strict');

const { shapeTile } = require('../lookbooks');

const R2 = 'https://cdn.example.com/mockups/img/abc.png';
const R2B = 'https://cdn.example.com/mockups/img/back.png';
const R2E = 'https://cdn.example.com/mockups/img/sleeve.png';
const INLINE = 'data:image/png;base64,AAAA';

const doc = (over = {}) => ({
  _id: 'lib1',
  name: 'Eastern Green Grinder',
  thumbnail: R2,
  data: R2B,
  extraViews: [R2E],
  pageState: { mockupNum: '#000148B' },
  ...over,
});
const page = { remoteId: 'rid-1', caption: 'Front & center' };

test('missing library doc → a missing tile (no image fields)', () => {
  const t = shapeTile(page, null, { views: true });
  assert.equal(t.missing, true);
  assert.equal(t.remoteId, 'rid-1');
  assert.equal(t.caption, 'Front & center');
  assert.equal(t.front, undefined);
});

test('front-only by default: no back/extraViews unless views requested', () => {
  const t = shapeTile(page, doc());
  assert.equal(t.front, R2);
  assert.equal(t.mockupNum, '#000148B');
  assert.equal(t.libraryId, 'lib1');
  assert.equal(t.back, undefined);
  assert.equal(t.extraViews, undefined);
});

test('views: carries back + every extra view as-is (public gallery cut)', () => {
  const t = shapeTile(page, doc(), { views: true });
  assert.equal(t.back, R2B);
  assert.deepEqual(t.extraViews, [R2E]);
});

test('urlOnly: keeps R2 URLs, drops inline-base64 back + views (admin cut)', () => {
  const t = shapeTile(page, doc({ data: INLINE, extraViews: [R2E, INLINE] }), { views: true, urlOnly: true });
  // the multi-MB inline back is stripped to empty so the debounced autosave
  // payload stays light; the URL-backed extra view survives, the inline one dies
  assert.equal(t.back, '');
  assert.deepEqual(t.extraViews, [R2E]);
});

test('urlOnly with all-URL images passes them through untouched', () => {
  const t = shapeTile(page, doc(), { views: true, urlOnly: true });
  assert.equal(t.back, R2B);
  assert.deepEqual(t.extraViews, [R2E]);
});

test('missing/blank view fields never crash and normalize to empties', () => {
  const t = shapeTile(page, doc({ data: '', extraViews: undefined }), { views: true });
  assert.equal(t.back, '');
  assert.deepEqual(t.extraViews, []);
});
