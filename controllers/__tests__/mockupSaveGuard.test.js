// controllers/__tests__/mockupSaveGuard.test.js
//   node --test controllers/__tests__/mockupSaveGuard.test.js
// The anti-clobber id resolver that keeps a mockup save from overwriting a
// DIFFERENT mockup when a client reuses a remoteId (duplicate / navigate-away).

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveMockupRemoteId } = require('../studioLibrary');

test('legit re-save: same number under the same id → unchanged (normal upsert)', () => {
  assert.equal(resolveMockupRemoteId('uuid-1', '#000145C', '#000145C'), 'uuid-1');
});

test('fresh save: no existing doc at this id → unchanged', () => {
  assert.equal(resolveMockupRemoteId('uuid-1', '#000145C', ''), 'uuid-1');
});

test('collision: id holds a DIFFERENT number → route to a derived id, original survives', () => {
  // client duplicated #145C but reused its id; incoming save is #145F
  assert.equal(resolveMockupRemoteId('uuid-1', '#000145F', '#000145C'), 'uuid-1::#000145F');
});

test('collision is idempotent: re-saving the same duplicate converges on one doc', () => {
  const first = resolveMockupRemoteId('uuid-1', '#000145F', '#000145C');
  // next save still comes in under the original id (client never adopted the fork)
  const again = resolveMockupRemoteId('uuid-1', '#000145F', '#000145C');
  assert.equal(first, again, 'same forked id every time — no proliferation');
  // and once the client DOES adopt the forked id, it is a normal re-save
  assert.equal(resolveMockupRemoteId('uuid-1::#000145F', '#000145F', '#000145F'), 'uuid-1::#000145F');
});

test('never double-suffixes an already-forked id', () => {
  // a save arriving on the forked id but the stored doc still mismatched
  const r = resolveMockupRemoteId('uuid-1::#000145F', '#000145F', '#000145C');
  assert.equal(r, 'uuid-1::#000145F', 'ends with the suffix already — left as-is');
});

test('missing numbers on either side never fork (nothing to protect)', () => {
  assert.equal(resolveMockupRemoteId('uuid-1', '', '#000145C'), 'uuid-1');
  assert.equal(resolveMockupRemoteId('uuid-1', '#000145C', ''), 'uuid-1');
  assert.equal(resolveMockupRemoteId('uuid-1', '', ''), 'uuid-1');
});
