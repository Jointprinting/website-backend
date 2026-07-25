// Carry-over: moving a design into a new project for a returning client.
//
// The number is the whole point. A mockup number encodes its project, so copying
// #000150A onto project 200 verbatim leaves a number that lies about where it
// lives — it can't be versioned, it letters wrong beside the project's own work,
// and it groups under the wrong design. A carry re-letters under the target and
// records the lineage instead.

const test = require('node:test');
const assert = require('node:assert');

const { buildCarriedMockup } = require('../orders');
const { parseMockupNum, baseForProject, clientDesignName } = require('../../utils/mockupNumbers');

const source = () => ({
  _id: 'src1',
  store: 'mockups',
  name: 'Happy Leaf Hoodie',
  client: 'Happy Leaf Dispensary',
  companyKey: 'happyleafdispensary',
  projectNumber: '150',
  thumbnail: 'https://r2/front.png',
  data: 'https://r2/back.png',
  extraViews: ['https://r2/p2-front.png'],
  extraBackViews: ['https://r2/p2-back.png'],
  pageState: { mockupNum: '#000150A', projectNumber: '150', client: 'Happy Leaf Dispensary', pdfName: '000150A.pdf' },
  pages: [
    { mockupNum: '#000150A', projectNumber: '150' },
    { mockupNum: '#000150A', projectNumber: '150' },
  ],
  remoteId: 'studio-abc',
});

const target = () => ({
  projectNumber: '200',
  companyName: 'Happy Leaf Dispensary',
  companyKey: 'happyleafdispensary',
});

test('re-letters under the TARGET project, not the source', () => {
  const out = buildCarriedMockup(source(), '#000200A', 'carry-1', target());
  assert.strictEqual(out.projectNumber, '200');
  assert.strictEqual(out.pageState.mockupNum, '#000200A');
  assert.strictEqual(parseMockupNum(out.pageState.mockupNum).base, baseForProject('200'));
});

test('records the lineage so the history stays queryable', () => {
  const out = buildCarriedMockup(source(), '#000200A', 'carry-1', target());
  assert.strictEqual(out.carriedFrom.projectNumber, '150');
  assert.strictEqual(out.carriedFrom.mockupNum, '#000150A');
  assert.ok(out.carriedFrom.at instanceof Date);
});

test('restamps the project inside pageState AND every page', () => {
  // The blob's copy and the real indexed field must never disagree — a legacy
  // reader and an indexed query have to see the same answer.
  const out = buildCarriedMockup(source(), '#000200B', 'carry-1', target());
  assert.strictEqual(out.pageState.projectNumber, '200');
  for (const p of out.pages) {
    assert.strictEqual(p.projectNumber, '200');
    assert.strictEqual(p.mockupNum, '#000200B');
  }
});

test('re-derives the PDF filename from the new number', () => {
  const out = buildCarriedMockup(source(), '#000200C', 'carry-1', target());
  assert.strictEqual(out.pageState.pdfName, '000200C.pdf',
    'otherwise the carried design exports under the old project’s name');
});

test('clones the art rather than sharing it', () => {
  const src = source();
  const out = buildCarriedMockup(src, '#000200A', 'carry-1', target());
  assert.notStrictEqual(out.extraViews, src.extraViews, 'must be a copy, not the same array');
  assert.notStrictEqual(out.extraBackViews, src.extraBackViews);
  out.extraViews.push('mutated');
  assert.strictEqual(src.extraViews.length, 1, 'editing the carry never touches the original');
});

test('carries page-2+ BACKS — the array that is their only carrier', () => {
  // pages[] have their base64 stripped on sync, so dropping extraBackViews
  // silently loses every extra page's back (the trap the variation clone hit).
  const out = buildCarriedMockup(source(), '#000200A', 'carry-1', target());
  assert.deepStrictEqual(out.extraBackViews, ['https://r2/p2-back.png']);
});

test('keeps the design name — a carry is not a variation', () => {
  const out = buildCarriedMockup(source(), '#000200A', 'carry-1', target());
  assert.strictEqual(out.name, 'Happy Leaf Hoodie');
});

test('drops a stale variation suffix from the source name', () => {
  const src = { ...source(), name: 'Happy Leaf Hoodie · v3' };
  const out = buildCarriedMockup(src, '#000200A', 'carry-1', target());
  assert.strictEqual(out.name, 'Happy Leaf Hoodie');
});

test('adopts the target project’s client identity', () => {
  const out = buildCarriedMockup(source(), '#000200A', 'carry-1', target());
  assert.strictEqual(out.companyKey, 'happyleafdispensary');
  assert.strictEqual(out.client, 'Happy Leaf Dispensary');
  assert.strictEqual(out.pageState.client, 'Happy Leaf Dispensary');
});

test('gets a fresh remoteId so the studio treats it as its own file', () => {
  const out = buildCarriedMockup(source(), '#000200A', 'carry-1', target());
  assert.strictEqual(out.remoteId, 'carry-1');
  assert.notStrictEqual(out.remoteId, source().remoteId);
});

test('the carried copy is versionable on its new project', () => {
  // The failure this fixes: a verbatim copy keeps base #000150, and the version
  // reserver refuses to letter it against project 200.
  const out = buildCarriedMockup(source(), '#000200A', 'carry-1', target());
  const parsed = parseMockupNum(out.pageState.mockupNum);
  assert.strictEqual(parsed.base, baseForProject('200'));
  assert.strictEqual(parsed.letter, 'A');
  assert.strictEqual(parsed.version, 1);
});

test('survives a sparse source without throwing', () => {
  const out = buildCarriedMockup({}, '#000200A', 'carry-1', target());
  assert.strictEqual(out.name, 'Mockup');
  assert.deepStrictEqual(out.extraViews, []);
  assert.deepStrictEqual(out.extraBackViews, []);
  assert.strictEqual(out.carriedFrom.mockupNum, '');
  assert.strictEqual(out.projectNumber, '200');
});

test('falls back to the pageState project when the field is unbackfilled', () => {
  const src = { ...source(), projectNumber: '' };
  const out = buildCarriedMockup(src, '#000200A', 'carry-1', target());
  assert.strictEqual(out.carriedFrom.projectNumber, '150');
});

test('clientDesignName strips the internal variation marker', () => {
  // "Add a variation" labels a clone "<design> · v2" so the owner's library
  // never shows two designs with the same name. A client identifies a design by
  // its NUMBER, so that marker must not reach a client-facing document.
  assert.strictEqual(clientDesignName('Happy Leaf Hoodie · v2'), 'Happy Leaf Hoodie');
  assert.strictEqual(clientDesignName('Happy Leaf Hoodie · v11'), 'Happy Leaf Hoodie');
});

test('clientDesignName only strips a TRAILING marker', () => {
  assert.strictEqual(clientDesignName('v2 Collection Tee'), 'v2 Collection Tee');
  assert.strictEqual(clientDesignName('Tee · v2 Collection'), 'Tee · v2 Collection');
  assert.strictEqual(clientDesignName('Series 5'), 'Series 5');
});

test('clientDesignName is empty-safe and idempotent', () => {
  assert.strictEqual(clientDesignName(''), '');
  assert.strictEqual(clientDesignName(null), '');
  assert.strictEqual(clientDesignName(clientDesignName('Hoodie · v4')), 'Hoodie');
});

test('clientDesignName matches the frontend mirror', () => {
  // src/common/mockupNum.js carries the same rule — drift would put the marker
  // back on one surface but not another.
  for (const [input, want] of [
    ['Hoodie ·v3', 'Hoodie'],
    ['Hoodie · v3   ', 'Hoodie'],
    ['Hoodie V', 'Hoodie V'],
  ]) assert.strictEqual(clientDesignName(input), want, `for ${JSON.stringify(input)}`);
});
