// utils/__tests__/archiveScope.test.js
//
// Pins the soft-delete guard contract shared by Transaction + ClientLogo: a normal
// read is scoped to live (archived:{$ne:true}) rows, while an explicit archived query
// or a withArchived opt-in is left untouched (so the trash/restore + revive paths can
// still reach archived docs). No DB — the merge logic is pure.
//
//   node --test utils/__tests__/archiveScope.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { LIVE_MATCH, scopeLiveFilter, scopeLivePipeline } = require('../archiveScope');

test('scopeLiveFilter injects the not-archived guard on a plain read', () => {
  assert.deepEqual(scopeLiveFilter({ orderNumber: '138' }), {
    orderNumber: '138', archived: { $ne: true },
  });
  // Empty filter → guard only.
  assert.deepEqual(scopeLiveFilter({}), { archived: { $ne: true } });
  assert.deepEqual(scopeLiveFilter(), { archived: { $ne: true } });
});

test('scopeLiveFilter leaves an explicit archived query alone (trash/restore view)', () => {
  const f = { _id: 'x', archived: true };
  assert.deepEqual(scopeLiveFilter(f), f);
  const f2 = { archived: { $ne: true } };
  assert.deepEqual(scopeLiveFilter(f2), f2);
});

test('scopeLiveFilter honours the withArchived opt-in (revive/upsert path)', () => {
  const f = { companyKey: 'acme' };
  assert.deepEqual(scopeLiveFilter(f, { withArchived: true }), f); // untouched → can reach archived
  assert.deepEqual(scopeLiveFilter(f, { withArchived: false }), {
    companyKey: 'acme', archived: { $ne: true },
  });
});

test('scopeLiveFilter does not mutate the caller filter', () => {
  const f = { party: 'Heritage' };
  const out = scopeLiveFilter(f);
  assert.equal('archived' in f, false, 'original filter untouched');
  assert.notEqual(out, f, 'returns a new object');
});

test('scopeLivePipeline prepends a not-archived $match', () => {
  const out = scopeLivePipeline([{ $match: { year: 2026 } }, { $group: { _id: '$category' } }]);
  assert.deepEqual(out[0], { $match: { archived: { $ne: true } } });
  assert.deepEqual(out[1], { $match: { year: 2026 } });
  assert.equal(out.length, 3);
});

test('scopeLivePipeline respects an existing leading archived match and the opt-in', () => {
  const already = [{ $match: { archived: true } }, { $group: { _id: null } }];
  assert.deepEqual(scopeLivePipeline(already), already);
  const p = [{ $group: { _id: null } }];
  assert.deepEqual(scopeLivePipeline(p, { withArchived: true }), p);
});

test('LIVE_MATCH is the canonical not-archived fragment', () => {
  assert.deepEqual(LIVE_MATCH, { archived: { $ne: true } });
});
