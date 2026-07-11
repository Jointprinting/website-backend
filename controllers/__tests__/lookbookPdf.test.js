// Pins the lookbook PDF's pure layout math: which layout a deck auto-picks from
// its mockup count, how many pages that takes, the cell grid geometry, and the
// contain-fit used to place each mockup image.
//
//   node --test controllers/__tests__/lookbookPdf.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickLayout, resolveLayout, perPage, pageCount, gridCells, fitContain, LAYOUTS, knockoutWhite } = require('../lookbookPdf');
let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* knockout test skips without sharp */ }

// ── auto-pick: a couple → hero, a handful → 2×2, a lot → contact sheet ──
test('pickLayout: count thresholds', () => {
  assert.equal(pickLayout(0), 'editorial');
  assert.equal(pickLayout(1), 'editorial');
  assert.equal(pickLayout(2), 'editorial');
  assert.equal(pickLayout(3), 'grid');
  assert.equal(pickLayout(8), 'grid');
  assert.equal(pickLayout(9), 'contact');
  assert.equal(pickLayout(40), 'contact');
});

test('resolveLayout: honors a real explicit layout, else auto-picks', () => {
  assert.equal(resolveLayout('contact', 1), 'contact');   // explicit wins
  assert.equal(resolveLayout('grid', 30), 'grid');        // explicit wins over auto
  assert.equal(resolveLayout('auto', 1), 'editorial');    // 'auto' → pick
  assert.equal(resolveLayout('nonsense', 9), 'contact');  // unknown → pick
  assert.equal(resolveLayout(undefined, 5), 'grid');      // missing → pick
});

// ── per-page + pagination ──
test('perPage: matches the layout grid', () => {
  assert.equal(perPage('editorial'), 1);
  assert.equal(perPage('grid'), 4);
  assert.equal(perPage('contact'), 9);
  assert.equal(perPage('nonsense'), 4);   // falls back to grid (2×2)
});

test('pageCount: ceil(count / perPage), 0 for an empty deck', () => {
  assert.equal(pageCount('editorial', 0), 0);
  assert.equal(pageCount('editorial', 3), 3);   // 1 per page
  assert.equal(pageCount('grid', 4), 1);
  assert.equal(pageCount('grid', 5), 2);
  assert.equal(pageCount('grid', 8), 2);
  assert.equal(pageCount('contact', 9), 1);
  assert.equal(pageCount('contact', 10), 2);
});

// ── grid geometry: equal cells, gutters consumed, row-major order ──
test('gridCells: 2×2 fills the box with gutters between cells', () => {
  const box = { x: 40, y: 60, w: 532, h: 686 };   // a real content box
  const cells = gridCells(box, 2, 2, 14);
  assert.equal(cells.length, 4);
  const cw = (532 - 14) / 2, ch = (686 - 14) / 2;
  // first cell sits at the box origin
  assert.equal(cells[0].x, 40);
  assert.equal(cells[0].y, 60);
  assert.equal(cells[0].w, cw);
  assert.equal(cells[0].h, ch);
  // row-major: index 1 is to the right, index 2 starts the next row
  assert.equal(cells[1].x, 40 + cw + 14);
  assert.equal(cells[1].y, 60);
  assert.equal(cells[2].x, 40);
  assert.equal(cells[2].y, 60 + ch + 14);
  // bottom-right cell stays inside the box
  assert.ok(cells[3].x + cells[3].w <= box.x + box.w + 1e-9);
  assert.ok(cells[3].y + cells[3].h <= box.y + box.h + 1e-9);
});

test('gridCells: a 1×1 cell is the whole box (no gutter applied)', () => {
  const box = { x: 0, y: 0, w: 100, h: 200 };
  const [cell] = gridCells(box, 1, 1, 14);
  assert.deepEqual(cell, { x: 0, y: 0, w: 100, h: 200 });
});

// ── contain-fit: scale to the limiting dimension, center, never overflow ──
test('fitContain: a wide image is width-limited and vertically centered', () => {
  const box = { x: 0, y: 0, w: 100, h: 100 };
  const r = fitContain(200, 100, box, 0);   // 2:1 image into a square
  assert.equal(r.w, 100);
  assert.equal(r.h, 50);
  assert.equal(r.x, 0);
  assert.equal(r.y, 25);   // centered in the leftover vertical space
});

test('fitContain: a tall image is height-limited and horizontally centered', () => {
  const box = { x: 0, y: 0, w: 100, h: 100 };
  const r = fitContain(100, 200, box, 0);   // 1:2 image into a square
  assert.equal(r.w, 50);
  assert.equal(r.h, 100);
  assert.equal(r.y, 0);
  assert.equal(r.x, 25);
});

test('fitContain: padding shrinks the usable box on every side', () => {
  const box = { x: 10, y: 10, w: 120, h: 120 };
  const r = fitContain(100, 100, box, 10);   // square in square, pad 10
  assert.equal(r.w, 100);   // 120 - 2*10
  assert.equal(r.h, 100);
  assert.equal(r.x, 20);    // box.x + pad
  assert.equal(r.y, 20);
});

test('fitContain: unusable sizes degrade to the padded box (no NaN/negative)', () => {
  const box = { x: 0, y: 0, w: 50, h: 50 };
  const r = fitContain(0, 0, box, 5);
  assert.equal(r.x, 5);
  assert.equal(r.y, 5);
  assert.equal(r.w, 40);
  assert.equal(r.h, 40);
  // a box smaller than its padding never yields a negative size
  const tiny = fitContain(10, 10, { x: 0, y: 0, w: 4, h: 4 }, 5);
  assert.ok(tiny.w >= 0 && tiny.h >= 0);
});

test('LAYOUTS: the three presets are the documented grids', () => {
  assert.deepEqual(LAYOUTS.editorial, { cols: 1, rows: 1 });
  assert.deepEqual(LAYOUTS.grid, { cols: 2, rows: 2 });
  assert.deepEqual(LAYOUTS.contact, { cols: 3, rows: 3 });
});

// ── white knockout: the "clean background" download baked in ──
test('knockoutWhite: white → transparent, a colored pixel stays opaque', async (t) => {
  if (!sharp) return t.skip('sharp not installed');
  // A 2×1 image: one pure-white pixel, one deep-green pixel.
  const src = await sharp(Buffer.from([255, 255, 255, 0, 128, 0]), { raw: { width: 2, height: 1, channels: 3 } }).png().toBuffer();
  const out = await knockoutWhite(src);
  const { data, info } = await sharp(out).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.channels, 4);
  assert.equal(data[3], 0);     // white pixel is now fully transparent
  assert.equal(data[7], 255);   // the green pixel keeps full opacity
});

test('knockoutWhite: a nullish/undecodable buffer is returned untouched (never throws)', async () => {
  assert.equal(await knockoutWhite(null), null);
  const junk = Buffer.from('not an image');
  assert.equal(await knockoutWhite(junk), junk);
});
