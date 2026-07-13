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
  pageState: { mockupNum: '#000148B', title: 'Grinder', template: 2, frontBlankBase64: 'data:x' },
  pages: [
    { mockupNum: '#000148B', view: 'front' },
    { mockupNum: '#000148B', view: 'back' },
  ],
  extraViews: ['data:image/png;base64,view2'],
  remoteId: 'orig-uuid',
};

test('restamps the new mockup number everywhere the old one lives', () => {
  const v = buildMockupVariation(SRC, '#000148F', 'var-123');
  assert.equal(v.pageState.mockupNum, '#000148F');
  assert.ok(v.pages.every((p) => p.mockupNum === '#000148F'));
  assert.equal(v.remoteId, 'var-123');
  // the art itself rides along untouched
  assert.equal(v.pageState.frontBlankBase64, 'data:x');
  assert.equal(v.thumbnail, SRC.thumbnail);
  assert.deepEqual(v.extraViews, SRC.extraViews);
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
  assert.ok(v.savedAt > 0);
});
