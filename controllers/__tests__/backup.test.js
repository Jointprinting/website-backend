// controllers/__tests__/backup.test.js
//
// Backup / restore safety + completeness. Pure logic — no DB. The export/restore
// core (controllers/backup) is factored into DB-agnostic helpers that operate on
// plain documents and a minimal Model interface, so the three things that MUST
// hold can be pinned without Mongo:
//
//   1. EXPORT covers EVERY collection — driven by mongoose.modelNames() minus an
//      explicit skip-set, so a future model is captured automatically and the
//      ones we deliberately drop (OAuth tokens, caches…) stay dropped.
//   2. RESTORE round-trips — export → restore → export yields identical data
//      (same collections, same counts, same documents), and the default merge
//      mode is idempotent (re-importing the same backup changes nothing).
//   3. RESTORE rejects a malformed / foreign archive BEFORE writing anything —
//      the database is never partially wiped on bad input.
//
//   node --test controllers/__tests__/backup.test.js

const test   = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const {
  getBackupModels, buildManifest, validateArchive, upsertOps, reviveId,
  assertRestorableDocs, applyRestore, SKIP_COLLECTIONS, SCHEMA_VERSION,
} = require('../backup');

// ── A tiny in-memory stand-in for a Mongoose model ───────────────────────────
// Implements exactly the surface backup.applyRestore touches: find().lean(),
// deleteMany(), insertMany(), bulkWrite() with replaceOne-upsert. Documents are
// keyed by String(_id) so upsert semantics match Mongo's.
function makeFakeModel(initial = []) {
  const store = new Map();
  for (const d of initial) store.set(String(d._id), { ...d });
  return {
    _store: store,
    find() { return { lean: async () => [...store.values()].map((d) => ({ ...d })) }; },
    async deleteMany() { store.clear(); },
    async insertMany(docs) { for (const d of docs) store.set(String(d._id), { ...d }); },
    async bulkWrite(ops) {
      for (const op of ops) {
        if (op.replaceOne) {
          const { filter, replacement } = op.replaceOne;
          store.set(String(filter._id), { ...replacement });
        }
      }
    },
  };
}

// A snapshot helper that mimics what appendBackupContents writes per collection:
// the raw lean() docs. Used to assert round-trip equality.
async function dump(models) {
  const out = {};
  for (const { name, Model } of models) out[name] = await Model.find().lean();
  return out;
}

// ── 1. Export completeness via modelNames ────────────────────────────────────

test('getBackupModels: includes the new business models that the old hardcoded list dropped', () => {
  // Register the models that were silently missing from the previous static list.
  // (mongoose dedupes by name, so re-requiring real models is harmless; here we
  //  just need the names present in the registry.)
  for (const name of ['Order', 'Client', 'Transaction', 'Vendor', 'PurchaseOrder', 'Counter']) {
    if (!mongoose.modelNames().includes(name)) {
      mongoose.model(name, new mongoose.Schema({}, { strict: false }));
    }
  }
  const names = getBackupModels().map((m) => m.name);
  for (const must of ['Order', 'Client', 'Transaction', 'Vendor', 'PurchaseOrder', 'Counter']) {
    assert.ok(names.includes(must), `backup must include ${must}`);
  }
});

test('getBackupModels: excludes exactly the transient / sensitive skip-set', () => {
  // Register the skip-set names so they exist in the registry to be excluded.
  for (const name of SKIP_COLLECTIONS) {
    if (!mongoose.modelNames().includes(name)) {
      mongoose.model(name, new mongoose.Schema({}, { strict: false }));
    }
  }
  const names = new Set(getBackupModels().map((m) => m.name));
  for (const skip of SKIP_COLLECTIONS) {
    assert.ok(!names.has(skip), `backup must NOT include ${skip}`);
  }
});

test('getBackupModels: a brand-new model is auto-included with zero code change', () => {
  const NAME = 'FutureWidget_test';
  if (!mongoose.modelNames().includes(NAME)) {
    mongoose.model(NAME, new mongoose.Schema({}, { strict: false }));
  }
  const names = getBackupModels().map((m) => m.name);
  assert.ok(names.includes(NAME), 'a future model must be backed up automatically');
});

test('getBackupModels: deterministic (sorted) ordering for stable manifests', () => {
  const names = getBackupModels().map((m) => m.name);
  assert.deepEqual(names, [...names].sort(), 'collections should be sorted');
});

// ── 2. Manifest shape ────────────────────────────────────────────────────────

test('buildManifest: records schema version, app id, collections AND per-collection counts', () => {
  const m = buildManifest(['Order', 'Client'], { Order: 3, Client: 7 });
  assert.equal(m.schemaVersion, SCHEMA_VERSION);
  assert.equal(m.app, 'joint-printing');
  assert.deepEqual(m.collections, ['Order', 'Client']);
  assert.deepEqual(m.counts, { Order: 3, Client: 7 });
  assert.ok(typeof m.createdAt === 'string' && m.createdAt.length > 0);
});

// ── 3. Archive validation (refuse bad input BEFORE any write) ─────────────────

const KNOWN = new Set(['Order', 'Client', 'Transaction', 'Vendor', 'PurchaseOrder', 'Counter']);

test('validateArchive: accepts a well-formed manifest + recognized collections', () => {
  assert.doesNotThrow(() =>
    validateArchive(
      { app: 'joint-printing', collections: ['Order', 'Client'] },
      ['Order', 'Client'],
      KNOWN,
    ));
});

test('validateArchive: rejects a missing manifest (a random zip is NOT a backup)', () => {
  assert.throws(() => validateArchive(null, ['Order'], KNOWN), /manifest\.json is missing/i);
});

test('validateArchive: rejects a manifest with no collections list', () => {
  assert.throws(() => validateArchive({ app: 'joint-printing' }, ['Order'], KNOWN), /no collections list/i);
});

test('validateArchive: rejects a foreign app archive', () => {
  assert.throws(
    () => validateArchive({ app: 'some-other-app', collections: ['Order'] }, ['Order'], KNOWN),
    /not Joint Printing/i,
  );
});

test('validateArchive: rejects an archive that carries no data files', () => {
  assert.throws(
    () => validateArchive({ app: 'joint-printing', collections: [] }, [], KNOWN),
    /no collection data/i,
  );
});

test('validateArchive: rejects an unknown/foreign collection (wrong file or newer version)', () => {
  assert.throws(
    () => validateArchive({ app: 'joint-printing', collections: ['Order', 'Mystery'] }, ['Order', 'Mystery'], KNOWN),
    /unknown collections: Mystery/i,
  );
});

// ── 4. Restore round-trip + idempotency (the headline safety guarantee) ───────

function fixtureModels() {
  const oid = () => new mongoose.Types.ObjectId();
  const orders = [
    { _id: oid(), orderNumber: '0000021', total: 100 },
    { _id: oid(), orderNumber: '0000022', total: 250 },
  ];
  const vendors = [{ _id: oid(), vendorName: 'Heritage Screen Printing' }];
  const counters = [{ _id: 'po', seq: 7 }, { _id: 'project', seq: 21 }];  // string _id (Counter)
  return [
    { name: 'Order',    Model: makeFakeModel(orders) },
    { name: 'Vendor',   Model: makeFakeModel(vendors) },
    { name: 'Counter',  Model: makeFakeModel(counters) },
  ];
}

test('restore round-trip (merge): export → restore-into-empty → export yields IDENTICAL data', async () => {
  const source = fixtureModels();
  const snapshotA = await dump(source);

  // "Export" = the lean docs; "restore" into a fresh, EMPTY set of collections.
  const target = source.map(({ name }) => ({ name, Model: makeFakeModel([]) }));
  const prepared = target.map(({ name, Model }) => ({ name, Model, docs: snapshotA[name] }));

  const res = await applyRestore(prepared, 'merge');

  const snapshotB = await dump(target);
  assert.deepEqual(snapshotB, snapshotA, 'restored data must equal the exported data');

  // Counts match the manifest-style report
  assert.equal(res.totalDocs, 2 + 1 + 2);
  assert.deepEqual(res.counts, { Order: 2, Vendor: 1, Counter: 2 });
});

test('restore merge is IDEMPOTENT: importing the same backup twice changes nothing', async () => {
  const source = fixtureModels();
  const snapshotA = await dump(source);
  const target = source.map(({ name }) => ({ name, Model: makeFakeModel([]) }));
  const prepared = target.map(({ name, Model }) => ({ name, Model, docs: snapshotA[name] }));

  await applyRestore(prepared, 'merge');
  const once = await dump(target);
  await applyRestore(prepared, 'merge');         // second import of the identical archive
  const twice = await dump(target);

  assert.deepEqual(twice, once, 'a second identical import must be a no-op');
  assert.deepEqual(twice, snapshotA);
});

test('restore merge UPSERTS by _id: existing doc updated in place, no duplicate row', async () => {
  const oid = new mongoose.Types.ObjectId();
  const target = [{ name: 'Order', Model: makeFakeModel([{ _id: oid, orderNumber: '21', total: 100 }]) }];
  // Same _id, new total — as a string _id, the way it arrives from JSON.
  const prepared = [{ name: 'Order', Model: target[0].Model, docs: [{ _id: String(oid), orderNumber: '21', total: 999 }] }];

  await applyRestore(prepared, 'merge');
  const rows = await target[0].Model.find().lean();
  assert.equal(rows.length, 1, 'must not create a duplicate');
  assert.equal(rows[0].total, 999, 'must update the existing doc in place');
});

test('restore merge NEVER deletes rows absent from the archive (additive, safe)', async () => {
  const keep = { _id: new mongoose.Types.ObjectId(), orderNumber: '99', total: 5 };
  const target = [{ name: 'Order', Model: makeFakeModel([keep]) }];
  const prepared = [{ name: 'Order', Model: target[0].Model,
    docs: [{ _id: String(new mongoose.Types.ObjectId()), orderNumber: '21', total: 100 }] }];

  await applyRestore(prepared, 'merge');
  const rows = await target[0].Model.find().lean();
  assert.equal(rows.length, 2, 'merge keeps pre-existing rows AND adds the imported one');
  assert.ok(rows.some((r) => r.orderNumber === '99'), 'pre-existing row survives a merge restore');
});

test('restore replace mode wipes then re-inserts (full replace), counts preserved', async () => {
  const stale = { _id: new mongoose.Types.ObjectId(), orderNumber: 'STALE', total: 1 };
  const target = [{ name: 'Order', Model: makeFakeModel([stale]) }];
  const fresh = [
    { _id: String(new mongoose.Types.ObjectId()), orderNumber: '21', total: 100 },
    { _id: String(new mongoose.Types.ObjectId()), orderNumber: '22', total: 200 },
  ];
  const prepared = [{ name: 'Order', Model: target[0].Model, docs: fresh }];

  await applyRestore(prepared, 'replace');
  const rows = await target[0].Model.find().lean();
  assert.equal(rows.length, 2, 'replace drops the stale row');
  assert.ok(!rows.some((r) => r.orderNumber === 'STALE'), 'stale row gone after replace');
});

// ── 5. _id revival (string from JSON → ObjectId so upsert matches) ────────────

test('reviveId: casts a 24-char hex string back to an ObjectId', () => {
  const oid = new mongoose.Types.ObjectId();
  const revived = reviveId(String(oid));
  assert.ok(revived instanceof mongoose.Types.ObjectId);
  assert.equal(String(revived), String(oid));
});

test('reviveId: leaves a non-ObjectId string _id (e.g. Counter "po") untouched', () => {
  assert.equal(reviveId('po'), 'po');
  assert.equal(reviveId('project'), 'project');
});

test('upsertOps: builds replaceOne-upsert ops keyed by the revived _id', () => {
  const oid = new mongoose.Types.ObjectId();
  const ops = upsertOps([{ _id: String(oid), x: 1 }, { _id: 'po', seq: 7 }]);
  assert.equal(ops.length, 2);
  assert.ok(ops[0].replaceOne.upsert === true);
  assert.ok(ops[0].replaceOne.filter._id instanceof mongoose.Types.ObjectId);
  assert.equal(ops[1].replaceOne.filter._id, 'po');           // string _id preserved
  assert.equal(ops[1].replaceOne.replacement.seq, 7);
});

// ── 6. Restorable-doc guards (close the silent-collapse / partial-wipe holes) ─

test('assertRestorableDocs: accepts docs that each have a unique _id', () => {
  assert.doesNotThrow(() => assertRestorableDocs('Order', [
    { _id: 'a', x: 1 }, { _id: 'b', x: 2 },
  ]));
});

test('assertRestorableDocs: REJECTS a doc with no _id (would collapse onto _id:null)', () => {
  assert.throws(() => assertRestorableDocs('Order', [{ x: 1 }]), /has no _id/i);
  assert.throws(() => assertRestorableDocs('Order', [{ _id: null, x: 1 }]), /has no _id/i);
  assert.throws(() => assertRestorableDocs('Order', [{ _id: '', x: 1 }]), /has no _id/i);
});

test('assertRestorableDocs: REJECTS duplicate _id within a collection (non-deterministic upsert)', () => {
  assert.throws(
    () => assertRestorableDocs('Order', [{ _id: 'dup' }, { _id: 'dup' }]),
    /two records with _id dup/i,
  );
  // ObjectId vs its string form collide too (same canonical key).
  const oid = new mongoose.Types.ObjectId();
  assert.throws(
    () => assertRestorableDocs('Order', [{ _id: oid }, { _id: String(oid) }]),
    /two records with _id/i,
  );
});

test('assertRestorableDocs: REJECTS a non-object array entry', () => {
  assert.throws(() => assertRestorableDocs('Order', [42]), /is not an object/i);
  assert.throws(() => assertRestorableDocs('Order', [null]), /is not an object/i);
});
