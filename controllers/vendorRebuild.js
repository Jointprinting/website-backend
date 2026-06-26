// controllers/vendorRebuild.js
//
// Admin-only endpoints for the owner-triggered "Rebuild printers from Drive" flow —
// the VENDOR/PO analogue of controllers/crmReconcile.js + controllers/financeRestart.js.
// THIN wrappers around the pure logic in services/vendorRebuild.js: they load the
// committed clean seed (data/vendorPoSeed.json) + the CURRENT live DB state, build
// the plan, and (only on an explicit confirm) apply it. All the diff/dedup/preserve
// logic is pure and unit-tested; nothing data-shaping lives here.
//
//   GET/POST /api/orders/vendors/rebuild/preview  → the PLAN (no writes; dryRun)
//   POST     /api/orders/vendors/rebuild/apply     → execute the plan (requires confirm)
//   POST     /api/orders/vendors/rebuild/revert    → undo a prior apply batch (by id)
//   GET      /api/orders/vendors/rebuild/status     → has it ever been applied?
//
// SAFETY (enforced here + in the pure layer; matches the CRM/finance reconcile):
//   • Nothing auto-applies. apply requires { confirm: true }.
//   • Idempotent: a second apply is a no-op (creates/loads/archives already done).
//   • Reversible: every touched record is stamped with rebuildBatchId, and the rows
//     it archives are SNAPSHOTTED into a VendorRebuildBatch (full backup). Revert
//     un-archives the snapshot + soft-archives what the batch created.
//   • Archive, NEVER hard-delete. The owner's one real in-app PO (the Happy Leaf
//     order's PO) is PRESERVED — matched by order/client, never archived.
//   • Dedup vendor name variants to the canonical folder name via utils/vendorMatch.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Vendor = require('../models/Vendor');
const PurchaseOrder = require('../models/PurchaseOrder');
const Order = require('../models/Order');
const VendorRebuildBatch = require('../models/VendorRebuildBatch');
const { bumpCounterTo } = require('../utils/sequence');
const {
  rehydrateDataset, buildRebuildPlan, normalizeOrderNumber,
} = require('../services/vendorRebuild');

const SEED_PATH = path.join(__dirname, '..', 'data', 'vendorPoSeed.json');

// Load + rehydrate the committed seed. Prefer the body's seed (dev only) if given.
function loadDataset(body = {}) {
  if (body && body.seed && typeof body.seed === 'object') return rehydrateDataset(body.seed);
  let seed;
  try {
    seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  } catch (e) {
    throw new Error('The cleaned vendor/PO seed (data/vendorPoSeed.json) is missing or unreadable. Re-run scripts/buildVendorPoSeed.js.');
  }
  return rehydrateDataset(seed);
}

// Pull the CURRENT live DB state the plan diffs against. ALL vendors + ALL POs
// (incl. archived, so "already archived" is distinct from "absent") + a slim order
// projection (for PO→order linking and the Happy-Leaf preserve test). Lean: read-only.
async function loadCurrentState() {
  const [vendors, pos, orders] = await Promise.all([
    Vendor.find({}).select('name archived nextPoStart source createdAt contactName email phone address shipMethod').lean(),
    PurchaseOrder.find({}).select('vendorName poNumber orderId archived source sourceFileId contactName').lean(),
    Order.find({}).select('orderNumber companyName clientName').lean(),
  ]);
  return { vendors, pos, orders };
}

// Build the plan from the seed + current state, with the rebuild options.
async function buildPlan(body = {}) {
  const dataset = loadDataset(body);
  const current = await loadCurrentState();
  const plan = buildRebuildPlan(dataset, current, {
    archiveSuperseded: body.archiveSuperseded !== false, // default ON
  });
  return { dataset, current, plan };
}

// ── GET/POST /preview ─────────────────────────────────────────────────────────
async function rebuildPreview(req, res) {
  try {
    const { dataset, plan } = await buildPlan(req.body || {});
    res.json({
      dryRun: true,
      summary: plan.summary,
      datasetSummary: dataset.summary,
      vendorsToCreate: plan.vendorsToCreate.map((v) => ({
        name: v.name, poCount: v.poCount, totalSpend: v.totalSpend,
        orders: v.orderNumbers.length, aliases: v.aliases, contactName: v.contactName, address: v.address,
      })),
      vendorsToUpdate: plan.vendorsToUpdate.map((u) => ({ name: u.seed.name, liveName: u.liveName, poCount: u.seed.poCount, totalSpend: u.seed.totalSpend })),
      posToLoad: plan.posToLoad.map((p) => ({
        vendorName: p.vendorName, poNumber: p.poNumber, date: p.date, client: p.client,
        grandTotal: p.grandTotal, orderNumber: p.linkedOrderNumber || p.orderNumber || '',
        linked: !!p.orderId, flags: p.flags,
      })),
      posAlreadyPresent: plan.posAlreadyPresent.length,
      vendorsToArchive: plan.vendorsToArchive.map((v) => ({ name: v.name, canonical: v.canonical })),
      posToArchive: plan.posToArchive.map((p) => ({ vendorName: p.vendorName, poNumber: p.poNumber })),
      preservedPos: plan.preservedPos.map((p) => ({ vendorName: p.vendorName, poNumber: p.poNumber, reason: p.reason })),
      flagged: plan.flagged,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── POST /apply ───────────────────────────────────────────────────────────────
// Executes the plan. REQUIRES { confirm: true }. Idempotent + reversible. Order of
// operations (non-destructive first, mirroring financeRestart):
//   1) CREATE + UPDATE the canonical vendors (enriched from spend), set nextPoStart.
//   2) LOAD the Drive POs (idempotency-guarded by sourceFileId), linked to orders.
//   3) SNAPSHOT then ARCHIVE the superseded in-app vendors/POs (soft), preserving
//      the Happy-Leaf PO. The snapshot is persisted in the batch BEFORE archiving.
async function rebuildApply(req, res) {
  try {
    const body = req.body || {};
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to apply without an explicit { confirm: true }. Run the preview first.' });
    }

    const { plan } = await buildPlan(body);
    const batchId = body.batchId || `vendorrebuild-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;

    const report = {
      batchId,
      vendorsCreated: 0, vendorsUpdated: 0,
      posLoaded: 0, posSkipped: plan.posAlreadyPresent.length,
      vendorsArchived: 0, posArchived: 0,
      preservedPos: plan.preservedPos.length,
      errors: [],
    };
    const createdVendorIds = [];
    const createdPoIds = [];

    // Resolve a canonical vendor NAME → its Vendor _id (create-or-find), so POs link
    // to the right printer. Built as we upsert vendors; falls back to a name lookup.
    const vendorIdByName = new Map();

    // 1) CREATE the canonical vendors.
    for (const v of plan.vendorsToCreate) {
      try {
        // Belt-and-suspenders: a re-run might find the vendor already created by a
        // prior partial apply — upsert by exact name so we never duplicate.
        let doc = await Vendor.findOne({ name: v.name });
        const isNew = !doc;
        if (!doc) doc = new Vendor({ name: v.name });
        // Fill profile blanks (never clobber an owner edit on a re-run).
        if (!doc.contactName && v.contactName) doc.contactName = v.contactName;
        if (!doc.email && v.email) doc.email = v.email;
        if (!doc.phone && v.phone) doc.phone = v.phone;
        if (!doc.address && v.address) doc.address = v.address;
        if (!doc.shipMethod && v.shipMethod) doc.shipMethod = v.shipMethod;
        if (v.nextPoStart && (!doc.nextPoStart || doc.nextPoStart < v.nextPoStart)) doc.nextPoStart = v.nextPoStart;
        // Fold the learned vendor↔order links from the ledger spend.
        const seen = new Set((doc.vendorOrders || []).map((l) => normalizeOrderNumber(l.orderNumber)).filter(Boolean));
        for (const on of (v.orderNumbers || [])) { if (on && !seen.has(on)) { doc.vendorOrders.push({ orderNumber: on, at: new Date() }); seen.add(on); } }
        if (doc.archived && ['superseded-by-rebuild', 'rebuild-revert'].includes(doc.archivedReason)) {
          doc.archived = false; doc.archivedAt = null; doc.archivedReason = '';
        }
        doc.source = 'drive-rebuild';
        doc.rebuildBatchId = batchId;
        await doc.save();
        vendorIdByName.set(v.name, doc._id);
        if (isNew) { report.vendorsCreated++; createdVendorIds.push(doc._id); } else { report.vendorsUpdated++; }
      } catch (err) {
        report.errors.push({ stage: 'vendor-create', name: v.name, message: err.message });
      }
    }

    // 1b) UPDATE existing canonical vendors (enrich profile + spend + nextPoStart).
    for (const u of plan.vendorsToUpdate) {
      try {
        const v = u.seed;
        const doc = await Vendor.findById(u._id);
        if (!doc) { report.errors.push({ stage: 'vendor-update', name: v.name, message: 'vendor not found' }); continue; }
        if (!doc.contactName && v.contactName) doc.contactName = v.contactName;
        if (!doc.email && v.email) doc.email = v.email;
        if (!doc.phone && v.phone) doc.phone = v.phone;
        if (!doc.address && v.address) doc.address = v.address;
        if (!doc.shipMethod && v.shipMethod) doc.shipMethod = v.shipMethod;
        if (v.nextPoStart && (!doc.nextPoStart || doc.nextPoStart < v.nextPoStart)) doc.nextPoStart = v.nextPoStart;
        const seen = new Set((doc.vendorOrders || []).map((l) => normalizeOrderNumber(l.orderNumber)).filter(Boolean));
        for (const on of (v.orderNumbers || [])) { if (on && !seen.has(on)) { doc.vendorOrders.push({ orderNumber: on, at: new Date() }); seen.add(on); } }
        doc.source = doc.source || 'drive-rebuild';
        doc.rebuildBatchId = batchId;
        await doc.save();
        vendorIdByName.set(v.name, doc._id);
        report.vendorsUpdated++;
      } catch (err) {
        report.errors.push({ stage: 'vendor-update', name: u.seed.name, message: err.message });
      }
    }

    // Helper: resolve a PO's vendor id (use the map; else look it up by exact name).
    const resolveVendorId = async (name) => {
      if (vendorIdByName.has(name)) return vendorIdByName.get(name);
      const v = await Vendor.findOne({ name, archived: { $ne: true } }).select('_id').lean();
      if (v) { vendorIdByName.set(name, v._id); return v._id; }
      return null;
    };

    // 2) LOAD the Drive POs. Each carries its sourceFileId (idempotency key) so a
    //    re-run that already loaded a doc skips it. orderId is OPTIONAL: a PO that
    //    links to a real in-app order carries it; one whose historical job was never
    //    entered in-app loads vendor-only (still shows on the printer's card + totals
    //    — the vendor↔order link comes from the ledger spend). Nothing is dropped.
    let posLoadedUnlinked = 0;
    for (const p of plan.posToLoad) {
      try {
        // Idempotency: skip if a PO with this sourceFileId already exists (live).
        if (p.sourceFileId) {
          const exists = await PurchaseOrder.findOne({ sourceFileId: p.sourceFileId, archived: { $ne: true } }).select('_id').lean();
          if (exists) { report.posSkipped++; continue; }
        }
        const date = p.date ? new Date(`${p.date}T00:00:00Z`) : new Date();
        const po = await PurchaseOrder.create({
          orderId: p.orderId || null,
          poNumber: p.poNumber,
          date,
          vendorName: p.vendorName,
          grandTotal: Number(p.grandTotal) || 0,
          notes: p.sourceTitle ? `Loaded from Drive: ${p.sourceTitle}` : '',
          source: 'drive-rebuild',
          sourceFileId: p.sourceFileId || '',
          rebuildBatchId: batchId,
        });
        createdPoIds.push(po._id);
        report.posLoaded++;
        if (!p.orderId) posLoadedUnlinked++;
        // Keep the per-vendor PO counter ahead of the loaded number so future
        // app-built POs continue the real run (the vendor floor also enforces this).
        await bumpCounterTo('po', p.poNumber, p.vendorName);
      } catch (err) {
        report.errors.push({ stage: 'po-load', poNumber: p.poNumber, vendor: p.vendorName, message: err.message });
      }
    }
    report.posLoadedUnlinked = posLoadedUnlinked;

    // 3) SNAPSHOT then ARCHIVE the superseded in-app vendors/POs (soft). Snapshot
    //    is saved in the batch FIRST so the backup is durable before any archive.
    const vendorArchIds = plan.vendorsToArchive.map((v) => v._id);
    const poArchIds = plan.posToArchive.map((p) => p._id);
    const archivedVendors = vendorArchIds.length ? await Vendor.find({ _id: { $in: vendorArchIds } }).lean() : [];
    const archivedPos = poArchIds.length ? await PurchaseOrder.find({ _id: { $in: poArchIds } }).lean() : [];

    await VendorRebuildBatch.create({
      batchId, status: 'applied',
      vendorsCreated: report.vendorsCreated, vendorsUpdated: report.vendorsUpdated,
      posLoaded: report.posLoaded, vendorsArchived: vendorArchIds.length, posArchived: poArchIds.length,
      preservedPos: report.preservedPos,
      createdVendorIds, createdPoIds,
      archivedVendors, archivedPos,
      note: 'Rebuild printers/POs from owner Google Drive history.',
    });

    if (vendorArchIds.length) {
      const r = await Vendor.updateMany(
        { _id: { $in: vendorArchIds }, archived: { $ne: true } },
        { $set: { archived: true, archivedAt: new Date(), archivedReason: 'superseded-by-rebuild', rebuildBatchId: batchId } },
      );
      report.vendorsArchived = r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
    }
    if (poArchIds.length) {
      const r = await PurchaseOrder.updateMany(
        { _id: { $in: poArchIds }, archived: { $ne: true } },
        { $set: { archived: true, archivedAt: new Date(), archivedReason: 'superseded-by-rebuild', rebuildBatchId: batchId } },
      );
      report.posArchived = r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
    }

    report.summary = plan.summary;
    res.json({ applied: true, ...report });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── GET /status ───────────────────────────────────────────────────────────────
// Has a rebuild EVER been applied (and not since reverted)? Lets the UI auto-hide
// the prominent "Rebuild printers from Drive" action once it's run.
async function rebuildStatus(req, res) {
  try {
    const last = await VendorRebuildBatch.findOne({ status: 'applied' })
      .sort({ at: -1 }).select('batchId at status').lean();
    res.json({ applied: !!last, lastBatchId: last ? (last.batchId || '') : '', at: last ? (last.at || null) : null });
  } catch (e) {
    res.json({ applied: false, lastBatchId: '', at: null, error: e.message });
  }
}

// ── POST /revert ──────────────────────────────────────────────────────────────
// Undo a prior apply batch by id: un-archive everything that batch archived (using
// the snapshot), and soft-archive the vendors/POs that batch created. Requires an
// explicit confirm. Idempotent: reverting an already-reverted batch is a no-op.
async function rebuildRevert(req, res) {
  try {
    const body = req.body || {};
    const batchId = body.batchId;
    if (!batchId) return res.status(400).json({ message: 'Provide the { batchId } to revert.' });
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to revert without an explicit { confirm: true }.' });
    }
    const batch = await VendorRebuildBatch.findOne({ batchId });
    if (!batch) return res.status(404).json({ message: `No vendor-rebuild batch found for id "${batchId}".` });
    if (batch.status === 'reverted') {
      return res.json({ reverted: true, batchId, alreadyReverted: true, note: 'This batch was already reverted.' });
    }

    // 1) Soft-archive the vendors + POs this batch CREATED.
    let createdVendorsArchived = 0;
    let createdPosArchived = 0;
    if ((batch.createdVendorIds || []).length) {
      const r = await Vendor.updateMany(
        { _id: { $in: batch.createdVendorIds }, archived: { $ne: true } },
        { $set: { archived: true, archivedAt: new Date(), archivedReason: 'rebuild-revert', rebuildBatchId: batchId } },
      );
      createdVendorsArchived = r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
    }
    if ((batch.createdPoIds || []).length) {
      const r = await PurchaseOrder.updateMany(
        { _id: { $in: batch.createdPoIds }, archived: { $ne: true } },
        { $set: { archived: true, archivedAt: new Date(), archivedReason: 'rebuild-revert', rebuildBatchId: batchId } },
      );
      createdPosArchived = r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
    }

    // 2) Un-archive the rows this batch ARCHIVED (restore from the snapshot ids).
    const restoreVendorIds = (batch.archivedVendors || []).map((v) => v._id).filter(Boolean);
    const restorePoIds = (batch.archivedPos || []).map((p) => p._id).filter(Boolean);
    let vendorsRestored = 0;
    let posRestored = 0;
    if (restoreVendorIds.length) {
      const r = await Vendor.updateMany(
        { _id: { $in: restoreVendorIds }, archived: true, archivedReason: 'superseded-by-rebuild' },
        { $set: { archived: false, archivedAt: null, archivedReason: '' } },
      );
      vendorsRestored = r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
    }
    if (restorePoIds.length) {
      const r = await PurchaseOrder.updateMany(
        { _id: { $in: restorePoIds }, archived: true, archivedReason: 'superseded-by-rebuild' },
        { $set: { archived: false, archivedAt: null, archivedReason: '' } },
      );
      posRestored = r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
    }

    batch.status = 'reverted';
    await batch.save();

    res.json({
      reverted: true, batchId,
      createdVendorsArchived, createdPosArchived,
      vendorsRestored, posRestored,
      note: 'Vendors/POs created by the batch were archived (recoverable); the in-app records it had superseded were restored.',
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

module.exports = {
  rebuildPreview,
  rebuildApply,
  rebuildStatus,
  rebuildRevert,
  // exported for tests / reuse
  loadDataset,
};
