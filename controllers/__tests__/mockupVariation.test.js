// controllers/__tests__/mockupVariation.test.js
//   node --test controllers/__tests__/mockupVariation.test.js
// The pure clone body behind POST /orders/:id/mockups/duplicate ("Add a variation").

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildMockupVariation } = require('../orders');

const SRC = {
  store: 'mockups',
  name: 'Eastern Green Grinder',
  thumbnail: 'data:image/png;base64,thumb',
  client: 'Eastern Green Dispensary',
  pageState: { mockupNum: '#000148B', pdfName: '000148B.pdf', title: 'Grinder', template: 2, frontBlankBase64: 'data:x' },
  pages: [
    { mockupNum: '#000148B', pdfName: '000148B.pdf', view: 'front' },
    { mockupNum: '#000148B', pdfName: '000148B.pdf', view: 'back' },
  ],
  extraViews: ['data:image/png;base64,view2'],
  extraBackViews: ['data:image/png;base64,back2'],
  remoteId: 'orig-uuid',
};

test('restamps the new mockup number everywhere the old one lives', () => {
  const v = buildMockupVariation(SRC, '#000148F', 'var-123');
  assert.equal(v.pageState.mockupNum, '#000148F');
  assert.ok(v.pages.every((p) => p.mockupNum === '#000148F'));
  assert.equal(v.remoteId, 'var-123');
  // the export filename follows the NEW number — a variation must never
  // export over its source's PDF (owner: "duplicates export as the next one")
  assert.equal(v.pageState.pdfName, '000148F.pdf');
  assert.ok(v.pages.every((p) => p.pdfName === '000148F.pdf'));
  // the art itself rides along untouched
  assert.equal(v.pageState.frontBlankBase64, 'data:x');
  assert.equal(v.thumbnail, SRC.thumbnail);
  assert.deepEqual(v.extraViews, SRC.extraViews);
  // page-2+ BACKS must ride along too — omitting them silently drops the back of
  // every extra page on a variation (the page-2-back data loss, regressed).
  assert.deepEqual(v.extraBackViews, SRC.extraBackViews);
  assert.equal(v.client, SRC.client);
});

test('names the variation off its letter and never stacks v-suffixes', () => {
  assert.equal(buildMockupVariation(SRC, '#000148F', 'x').name, 'Eastern Green Grinder · v6'); // F = 6th
  // duplicating a variation strips the old suffix before adding the new one
  const again = buildMockupVariation({ ...SRC, name: 'Eastern Green Grinder · v6' }, '#000148G', 'y');
  assert.equal(again.name, 'Eastern Green Grinder · v7');
});

test('single-page mockups (pages: null) and missing fields survive', () => {
  const v = buildMockupVariation({ name: 'Tee', pageState: { mockupNum: '#000001A' } }, '#000001B', 'z');
  assert.equal(v.pages, null);
  assert.equal(v.pageState.mockupNum, '#000001B');
  assert.equal(v.store, 'mockups');
  assert.equal(v.extraViews.length, 0);
  assert.equal(v.extraBackViews.length, 0);
  assert.ok(v.savedAt > 0);
});

// ── The project + client links ───────────────────────────────────────────────
//
// This clone writes STRAIGHT to the collection — no saveItem, which is where
// every other creation path derives companyKey/projectNumber. It stamped
// neither, so a variation landed with both keys empty. The Studio's project
// panel didn't notice (it falls back to pageState.projectNumber, which rides
// along in the spread), but every client-facing surface queries the real
// fields — so each variation was invisible on the client's approval link until
// the next boot's backfill promoted it. Four mockups on the link, eight on the
// project. buildCarriedMockup had always stamped both; this is the parity.

test('stamps the project + client links from the order being varied on', () => {
  const target = { projectNumber: '145', companyKey: 'longislandsoundcustomboatworks' };
  const v = buildMockupVariation(SRC, '#000145F', 'var-1', target);
  assert.equal(v.projectNumber, '145');
  assert.equal(v.companyKey, 'longislandsoundcustomboatworks');
  // …and the blob's copy stays in step with the real field, so a legacy reader
  // and an indexed query can never disagree about which project this is on.
  assert.equal(v.pageState.projectNumber, '145');
});

test('with no target, a variation inherits its SOURCE\'s links', () => {
  // A variation always lives on the same project as the design it varies.
  const src = { ...SRC, projectNumber: '148', companyKey: 'easterngreen' };
  const v = buildMockupVariation(src, '#000148F', 'var-2');
  assert.equal(v.projectNumber, '148');
  assert.equal(v.companyKey, 'easterngreen');
  assert.equal(v.pageState.projectNumber, '148');
});

test('falls back to the source\'s pageState blob when the field is unstamped', () => {
  // Varying a variation made before this fix: the field is empty, the blob isn't.
  const src = { ...SRC, pageState: { ...SRC.pageState, projectNumber: '148' } };
  const v = buildMockupVariation(src, '#000148G', 'var-3');
  assert.equal(v.projectNumber, '148');
});

test('the target outranks the source', () => {
  const src = { ...SRC, projectNumber: '148', companyKey: 'easterngreen' };
  const v = buildMockupVariation(src, '#000145F', 'var-4', { projectNumber: '145', companyKey: 'lis' });
  assert.equal(v.projectNumber, '145');
  assert.equal(v.companyKey, 'lis');
});

test('an unlinkable source stays unlinked rather than inventing a project', () => {
  const v = buildMockupVariation({ name: 'Tee', pageState: { mockupNum: '#000001A' } }, '#000001B', 'z');
  assert.equal(v.projectNumber, '');
  assert.equal(v.companyKey, '');
  // Nothing to stamp → the blob is left exactly as it was, not blanked.
  assert.equal(v.pageState.projectNumber, undefined);
});
