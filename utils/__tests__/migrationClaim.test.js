// utils/__tests__/migrationClaim.test.js
//   node --test utils/__tests__/migrationClaim.test.js
//
// The boot migrations were check-then-act, and a Render deploy boots the new
// instance while the old one is still serving — so two processes reach the check
// before either writes. Both ran the work. For the NDR resweep that suppressed
// the same dead addresses twice.
//
// These tests model the collection's ACTUAL contract: `_id` is unique, and an
// upsert whose filter matches nothing attempts an insert that then fails with
// E11000. That duplicate-key error is the lock.

const test = require('node:test');
const assert = require('node:assert/strict');

const { claim, finish, fail, runOnce } = require('../migrationClaim');

// A minimal stand-in for a Mongo collection with a unique _id. Deliberately
// small: the only behaviour under test is who wins a contested claim.
function fakeCollection(seed = []) {
  const docs = new Map(seed.map((d) => [d._id, { ...d }]));
  const matches = (doc, filter) => {
    if (!doc) return false;
    if (filter.$or) {
      return filter.$or.some((clause) => Object.entries(clause).every(([k, v]) => {
        if (v && typeof v === 'object' && '$lt' in v) return doc[k] != null && doc[k] < v.$lt;
        return doc[k] === v;
      }));
    }
    return true;
  };
  return {
    docs,
    async findOneAndUpdate(filter, update, options = {}) {
      const existing = docs.get(filter._id);
      if (existing && matches(existing, filter)) {
        Object.assign(existing, update.$set || {});
        for (const [k, n] of Object.entries(update.$inc || {})) existing[k] = (existing[k] || 0) + n;
        return existing;
      }
      if (existing) {
        // Filter didn't match a doc that exists → the upsert insert collides.
        const err = new Error('E11000 duplicate key error');
        err.code = 11000;
        throw err;
      }
      if (!options.upsert) return null;
      const created = { _id: filter._id, ...(update.$set || {}) };
      for (const [k, n] of Object.entries(update.$inc || {})) created[k] = n;
      docs.set(filter._id, created);
      return created;
    },
    async updateOne(filter, update) {
      const d = docs.get(filter._id);
      if (!d) return { matchedCount: 0 };
      Object.assign(d, update.$set || {});
      for (const k of Object.keys(update.$unset || {})) delete d[k];
      return { matchedCount: 1 };
    },
  };
}

test('a fresh migration is claimable', async () => {
  const col = fakeCollection();
  assert.equal(await claim(col, 'm1'), true);
  assert.equal(col.docs.get('m1').state, 'running');
});

test('THE RACE: two instances booting together — exactly one wins', async () => {
  const col = fakeCollection();
  const [a, b] = await Promise.all([claim(col, 'm1'), claim(col, 'm1')]);
  assert.equal([a, b].filter(Boolean).length, 1,
    'both booters must not run the migration — that is the bug this replaces');
});

test('a completed migration is never re-run', async () => {
  const col = fakeCollection();
  await claim(col, 'm1');
  await finish(col, 'm1', { modified: 12 });
  assert.equal(await claim(col, 'm1'), false);
  assert.equal(col.docs.get('m1').state, 'done');
  assert.deepEqual(col.docs.get('m1').result, { modified: 12 });
});

test('a LEGACY marker (written before states existed) counts as done', async () => {
  // Every migration already run in production looks like this. None may re-run.
  const col = fakeCollection([{ _id: 'retriageAutoAcks-v5', at: new Date('2026-01-01') }]);
  assert.equal(await claim(col, 'retriageAutoAcks-v5'), false);
});

test('a migration still running elsewhere is not stolen', async () => {
  const col = fakeCollection();
  await claim(col, 'm1', { now: new Date('2026-08-22T12:00:00Z') });
  const soonAfter = new Date('2026-08-22T12:05:00Z');
  assert.equal(await claim(col, 'm1', { now: soonAfter }), false,
    'taking over a live migration re-creates the double-run');
});

test('a FAILED migration is retried on the next boot', async () => {
  const col = fakeCollection();
  await claim(col, 'm1');
  await fail(col, 'm1', new Error('Atlas timed out'));
  assert.equal(col.docs.get('m1').state, 'failed');
  assert.equal(col.docs.get('m1').error, 'Atlas timed out');
  assert.equal(await claim(col, 'm1'), true, 'a failure must not wedge the migration forever');
  assert.equal(col.docs.get('m1').attempts, 2, 'attempts are counted');
});

test('a claim whose owner plainly died is taken over after the stale window', async () => {
  const col = fakeCollection();
  await claim(col, 'm1', { now: new Date('2026-08-22T12:00:00Z') });
  const muchLater = new Date('2026-08-22T13:30:00Z');   // 90 min
  assert.equal(await claim(col, 'm1', { now: muchLater }), true);
});

test('runOnce: the work runs once and its result is recorded', async () => {
  const col = fakeCollection();
  let runs = 0;
  const fn = async () => { runs += 1; return { demoted: 3 }; };
  const [r1, r2] = await Promise.all([runOnce(col, 'm1', fn), runOnce(col, 'm1', fn)]);
  assert.equal(runs, 1, 'the whole point');
  assert.equal([r1.ran, r2.ran].filter(Boolean).length, 1);
  assert.equal(col.docs.get('m1').state, 'done');
  assert.deepEqual(col.docs.get('m1').result, { demoted: 3 });
});

test('runOnce: a throwing migration marks failed and does NOT take the boot down', async () => {
  const col = fakeCollection();
  const out = await runOnce(col, 'm1', async () => { throw new Error('boom'); });
  assert.equal(out.ran, false);
  assert.equal(out.reason, 'failed');
  assert.equal(col.docs.get('m1').state, 'failed');
  // ...and it retries next boot.
  assert.equal(await claim(col, 'm1'), true);
});

test('runOnce: a non-object return is still recorded', async () => {
  const col = fakeCollection();
  await runOnce(col, 'm1', async () => 7);
  assert.deepEqual(col.docs.get('m1').result, { value: 7 });
});
