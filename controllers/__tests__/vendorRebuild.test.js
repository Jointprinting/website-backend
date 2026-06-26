// controllers/__tests__/vendorRebuild.test.js
//
// Pure-logic checks (no DB, no extra dev deps) for the "Rebuild printers from Drive"
// reconcile (services/vendorRebuild.js + the committed seed). Mirrors the
// crmReconcile / financeRestart test style: feed the pure plan builder real data and
// assert the SAFETY invariants the owner relies on:
//   • vendor name variants fold to ONE canonical printer (Heritage variants → one);
//   • the plan creates the 16 real printers + loads their POs; a re-run is a no-op;
//   • the Happy-Leaf in-app PO is PRESERVED (never archived); old in-app POs that map
//     to a Drive printer ARE archived (soft); non-Drive POs are left alone;
//   • POs link to orders by order number / unambiguous client;
//   • the committed seed (data/vendorPoSeed.json) is well-formed (16 vendors, no
//     duplicate canonical names, every loadable PO has a sourceFileId).
//
//   node --test controllers/__tests__/vendorRebuild.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  canonicalVendorName, aliasMapFromDataset, rehydrateDataset, buildRebuildPlan,
  isHappyLeafName, poIsPreserved, VENDOR_FOLDERS, normalizeOrderNumber,
} = require('../../services/vendorRebuild');
const { vendorKey } = require('../../utils/vendorMatch');

const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', 'vendorPoSeed.json'), 'utf8'));
const DS = rehydrateDataset(SEED);
const NAMES = DS.vendors.map((v) => v.name);
const ALIASES = aliasMapFromDataset(DS);

// ───────────────────────────── canonicalization ─────────────────────────────
test('canonicalVendorName: exact folder name resolves to itself', () => {
  assert.equal(canonicalVendorName('Heritage Screen Printing', NAMES, ALIASES), 'Heritage Screen Printing');
  assert.equal(canonicalVendorName('Cannabis Promotions', NAMES, ALIASES), 'Cannabis Promotions');
});

test('canonicalVendorName: short/variant names fold to the canonical folder (Heritage variants → one)', () => {
  assert.equal(canonicalVendorName('Heritage', NAMES, ALIASES), 'Heritage Screen Printing');
  assert.equal(canonicalVendorName('Hertage Screen Printing', NAMES, ALIASES), 'Heritage Screen Printing'); // ledger typo
  assert.equal(canonicalVendorName('CannabisPromotions', NAMES, ALIASES), 'Cannabis Promotions');
  assert.equal(canonicalVendorName('Blue Frog', NAMES, ALIASES), 'BlueFrog');
  assert.equal(canonicalVendorName('Tekweld', NAMES, ALIASES), 'TekWeld');
});

test('canonicalVendorName: distinguishing-word aliases fold via the explicit alias map', () => {
  // "east"/"world" are distinguishing words the conservative fuzzy test won't merge,
  // so they MUST come from the owner-recorded alias list.
  assert.equal(canonicalVendorName('Apollo East', NAMES, ALIASES), 'Apollo');
  assert.equal(canonicalVendorName('Apollo USA - East Coast', NAMES, ALIASES), 'Apollo');
  assert.equal(canonicalVendorName('Bic World', NAMES, ALIASES), 'BIC');
  assert.equal(canonicalVendorName('Bic', NAMES, ALIASES), 'BIC');
});

test('canonicalVendorName: a non-printer (blank supplier / unrelated) does NOT resolve', () => {
  assert.equal(canonicalVendorName('Alphabroder', NAMES, ALIASES), '');
  assert.equal(canonicalVendorName('S&S Activewear', NAMES, ALIASES), '');
  assert.equal(canonicalVendorName('Happy Leaf', NAMES, ALIASES), '');
  assert.equal(canonicalVendorName('', NAMES, ALIASES), '');
  assert.equal(canonicalVendorName('Unassigned', NAMES, ALIASES), '');
});

// ───────────────────────────── the seed itself ──────────────────────────────
test('seed: exactly the 16 printer folders, canonical + unique', () => {
  assert.equal(DS.vendors.length, 16);
  const keys = DS.vendors.map((v) => vendorKey(v.name));
  assert.equal(new Set(keys).size, 16, 'no two vendors share a canonical key');
  const folderTitles = new Set(VENDOR_FOLDERS.map((f) => f.title));
  for (const v of DS.vendors) assert.ok(folderTitles.has(v.name), `${v.name} is a known folder`);
});

test('seed: every loadable PO carries a sourceFileId (idempotency key) + a vendor that is one of the 16', () => {
  const names = new Set(NAMES);
  for (const p of DS.purchaseOrders) {
    assert.ok(p.sourceFileId, `PO ${p.vendorName} ${p.poNumber} has a sourceFileId`);
    assert.ok(names.has(p.vendorName), `PO vendor ${p.vendorName} is one of the 16`);
  }
});

test('seed: vendor nextPoStart continues past the highest numeric Drive PO', () => {
  // Heritage's Drive run goes to #008, so the floor must be ≥ 9 (continue, not collide).
  const heritage = DS.vendors.find((v) => v.name === 'Heritage Screen Printing');
  assert.ok(heritage.nextPoStart >= 9, `Heritage nextPoStart ${heritage.nextPoStart} ≥ 9`);
});

// ───────────────────────────── the plan (empty DB) ──────────────────────────
test('plan (near-empty in-app DB): creates all 16 printers + loads every PO; nothing to archive', () => {
  const plan = buildRebuildPlan(DS, { vendors: [], pos: [], orders: [] }, {});
  assert.equal(plan.summary.vendorsToCreate, 16);
  assert.equal(plan.summary.vendorsToUpdate, 0);
  assert.equal(plan.summary.posToLoad, DS.purchaseOrders.length);
  assert.equal(plan.summary.vendorsToArchive, 0);
  assert.equal(plan.summary.posToArchive, 0);
  assert.equal(plan.summary.noOp, false);
});

test('plan idempotency: a re-run after a full prior rebuild is a no-op (POs matched by sourceFileId)', () => {
  // Simulate the post-apply state: every Drive PO present (with its sourceFileId)
  // and every vendor present. The next preview must propose ZERO new work.
  const livePos = DS.purchaseOrders.map((p, i) => ({
    _id: `pp${i}`, vendorName: p.vendorName, poNumber: p.poNumber,
    orderId: 'someorder', archived: false, source: 'drive-rebuild', sourceFileId: p.sourceFileId,
  }));
  const liveVendors = DS.vendors.map((v, i) => ({ _id: `vv${i}`, name: v.name, archived: false, source: 'drive-rebuild', nextPoStart: v.nextPoStart }));
  const plan = buildRebuildPlan(DS, { vendors: liveVendors, pos: livePos, orders: [{ _id: 'someorder', orderNumber: '1', companyName: 'X' }] }, {});
  assert.equal(plan.summary.posToLoad, 0, 'no POs to load on re-run');
  assert.equal(plan.summary.posAlreadyPresent, DS.purchaseOrders.length);
  assert.equal(plan.summary.vendorsToCreate, 0, 'no vendors to create on re-run');
  assert.equal(plan.summary.noOp, true, 're-run is a true no-op');
});

// ──────────────────────── Happy-Leaf preservation ───────────────────────────
test('isHappyLeafName matches the owner order; poIsPreserved guards its PO', () => {
  assert.ok(isHappyLeafName('Happy Leaf Dispensary'));
  assert.ok(isHappyLeafName('happy leaf'));
  assert.ok(!isHappyLeafName('Heritage Screen Printing'));
  const orderNameById = new Map([['o_happy', 'Happy Leaf Dispensary'], ['o_other', 'JFS']]);
  // A PO on the Happy-Leaf order is preserved EVEN IF its vendor maps to a Drive folder.
  assert.ok(poIsPreserved({ _id: 'p', vendorName: 'Heritage', orderId: 'o_happy' }, orderNameById));
  assert.ok(!poIsPreserved({ _id: 'p', vendorName: 'Heritage', orderId: 'o_other' }, orderNameById));
});

test('plan PRESERVES the Happy-Leaf in-app PO and ARCHIVES an old in-app Drive-printer PO', () => {
  const orders = [
    { _id: 'o_happy', orderNumber: '77', companyName: 'Happy Leaf Dispensary', clientName: 'Happy Leaf Dispensary' },
    { _id: 'o1', orderNumber: '000001', companyName: 'JFS', clientName: 'JFS' },
    { _id: 'o31', orderNumber: '31', companyName: 'SomeCo', clientName: 'SomeCo' },
  ];
  const current = {
    vendors: [
      { _id: 'v_her', name: 'Heritage', archived: false, source: 'auto', nextPoStart: 0 },
      { _id: 'v_apo', name: 'Apollo East', archived: false, source: '', nextPoStart: 0 },
    ],
    pos: [
      // The owner's one real in-app PO — on the Happy Leaf order. MUST be preserved.
      { _id: 'po_happy', vendorName: 'Heritage', poNumber: '#001', orderId: 'o_happy', archived: false, source: '' },
      // An old auto-created in-app PO for a Drive printer. MUST be archived.
      { _id: 'po_apollo_old', vendorName: 'Apollo East', poNumber: '#0001', orderId: 'o1', archived: false, source: '' },
      // A PO for a printer that isn't in the Drive set. MUST be left alone.
      { _id: 'po_other', vendorName: 'Some Random Vendor', poNumber: '#1', orderId: 'o31', archived: false, source: '' },
    ],
    orders,
  };
  const plan = buildRebuildPlan(DS, current, {});

  const preservedIds = plan.preservedPos.map((p) => p._id);
  assert.ok(preservedIds.includes('po_happy'), 'Happy-Leaf PO preserved');
  assert.ok(preservedIds.includes('po_other'), 'non-Drive PO preserved');

  const archivedIds = plan.posToArchive.map((p) => p._id);
  assert.ok(archivedIds.includes('po_apollo_old'), 'old in-app Apollo PO archived');
  assert.ok(!archivedIds.includes('po_happy'), 'Happy-Leaf PO NEVER in the archive list');

  // The live "Heritage" + "Apollo East" vendors fold onto the canonical survivors
  // (update targets), so they are NOT in the archive list (no data lost, no dupe).
  assert.equal(plan.summary.vendorsToArchive, 0);
  const updNames = plan.vendorsToUpdate.map((u) => u.seed.name).sort();
  assert.deepEqual(updNames, ['Apollo', 'Heritage Screen Printing']);
});

test('plan never proposes a HARD delete — only create / update / load / soft-archive lists exist', () => {
  const plan = buildRebuildPlan(DS, { vendors: [{ _id: 'x', name: 'Heritage', archived: false, source: 'auto' }], pos: [], orders: [] }, {});
  // The plan's only mutating outputs are these named lists — there is no "toDelete".
  assert.deepEqual(
    Object.keys(plan).filter((k) => /delete|remove|destroy/i.test(k)),
    [],
    'no delete/remove/destroy keys in the plan',
  );
});

// ──────────────────────── PO → order linking ────────────────────────────────
test('plan links a Drive PO to its order by an unambiguous client/merch-line match', () => {
  // Heritage #008 client is "Coastline Dispensary Merch". An order with that company
  // should link; the "Merch"/"The " noise is stripped for the match.
  const orders = [
    { _id: 'oA', orderNumber: '131', companyName: 'Coastline Dispensary', clientName: 'Coastline Dispensary' },
  ];
  const plan = buildRebuildPlan(DS, { vendors: [], pos: [], orders }, {});
  const her008 = plan.posToLoad.find((p) => p.vendorName === 'Heritage Screen Printing' && p.poNumber === '#008');
  assert.ok(her008, 'Heritage #008 is in the load list');
  assert.equal(String(her008.orderId), 'oA', 'Heritage #008 linked to the Coastline order');
});

test('plan does NOT link when a client name is ambiguous (claimed by >1 order)', () => {
  const orders = [
    { _id: 'o1', orderNumber: '10', companyName: 'The CannaBoss Lady', clientName: 'The CannaBoss Lady' },
    { _id: 'o2', orderNumber: '11', companyName: 'The CannaBoss Lady', clientName: 'The CannaBoss Lady' },
  ];
  const plan = buildRebuildPlan(DS, { vendors: [], pos: [], orders }, {});
  // Contract-DTG #0001's client is "The CannaBoss Lady Merch" — two orders claim it,
  // so it must NOT auto-link (no guess).
  const dtg = plan.posToLoad.find((p) => p.vendorName === 'Contract-DTG' && p.poNumber === '#0001');
  assert.ok(dtg, 'Contract-DTG #0001 still loads');
  assert.equal(dtg.orderId, null, 'ambiguous client → no link (never guesses)');
});

// ──────────────────────── ledger spend on the vendor ────────────────────────
test('seed: each vendor carries its actual ledger spend + the orders it printed', () => {
  const heritage = DS.vendors.find((v) => v.name === 'Heritage Screen Printing');
  // Heritage spend = the three ledger variants folded (Heritage Screen Printing +
  // Heritage + Hertage Screen Printing) = 2586.40 + 205.00 + 60.00.
  assert.ok(Math.abs(heritage.totalSpend - 2851.40) < 0.01, `Heritage spend ${heritage.totalSpend} ≈ 2851.40`);
  assert.ok(heritage.orderNumbers.length > 0, 'Heritage has connected orders from the ledger');
  // Order numbers are normalized (digits only, no leading zeros).
  for (const on of heritage.orderNumbers) assert.equal(on, normalizeOrderNumber(on));
});
