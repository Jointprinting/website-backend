// controllers/crmReconcile.js
//
// Admin-only endpoints for the owner-triggered "load / reconcile my data" flow.
// These are THIN wrappers around the pure logic in services/crmReconcile.js: they
// load the committed clean seed + the CURRENT live DB state, build the plan, and
// (only on an explicit confirm) apply it. The diff/dedup/discrepancy logic is all
// pure and unit-tested; nothing data-shaping lives here.
//
//   GET/POST /api/crm/reconcile/preview   → the PLAN (no writes; dryRun)
//   POST     /api/crm/reconcile/apply     → execute the plan (requires confirm)
//   POST     /api/crm/reconcile/revert    → undo a prior apply batch (by id)
//
// SAFETY (enforced here + in the pure layer):
//   • Nothing auto-applies. apply requires { confirm: true }.
//   • Idempotent: a second apply is a no-op (creates/loads/archives already done).
//   • Reversible: every touched record is stamped with reconcileBatchId; revert
//     restores them.
//   • Archive, never hard-delete. Cold/lost real records are KEPT.
//   • Dedup against EXISTING live Clients by exact companyKey — never a dupe.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Client = require('../models/Client');
const Order  = require('../models/Order');
const { applyImportToDoc } = require('./crm');
const {
  buildCleanDataset, buildReconcilePlan, normalizeOrderNumber,
} = require('../services/crmReconcile');

const SEED_PATH = path.join(__dirname, '..', 'data', 'notionCrmSeed.json');
const KNOWN_PATH = path.join(__dirname, '..', 'data', 'reconcileKnownDiscrepancies.json');

// Load the committed seed. Prefer the pre-built JSON (data/notionCrmSeed.json);
// fall back to building it from a CSV path in the body (dev only) if provided.
// Returns a dataset in the SAME shape buildCleanDataset emits (clients/orders/
// junk/discrepancies/summary), with Date fields rehydrated from ISO strings.
function loadDataset(body = {}) {
  let known = [];
  try { known = JSON.parse(fs.readFileSync(KNOWN_PATH, 'utf8')); } catch (_) { known = []; }

  if (body && typeof body.csv === 'string' && body.csv.trim()) {
    return buildCleanDataset(body.csv, { year: new Date().getUTCFullYear(), knownDiscrepancies: known });
  }
  let seed;
  try {
    seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  } catch (e) {
    throw new Error('The cleaned data seed (data/notionCrmSeed.json) is missing or unreadable. Re-run scripts/buildNotionCrmSeed.js.');
  }
  // Rehydrate the seed JSON into the live dataset shape the plan expects.
  const clients = (seed.clients || []).map((c) => ({
    ...c,
    lastContact: c.lastContact ? new Date(c.lastContact) : null,
    nextFollowUp: c.nextFollowUp ? new Date(c.nextFollowUp) : null,
    tags: c.tags || [],
    akas: c.akas || [],
    contacts: c.contacts || [],
    logs: c.logs || [],
    ambiguousDates: [],
  }));
  const orders = (seed.orders || []).map((o) => ({ ...o }));
  const junk = (seed.metaAdJunk || []).map((j) => ({
    companyKey: j.companyKey, name: j.name, orderNumber: j.orderNumber || '', hadOrderNumber: !!j.orderNumber,
  }));
  const orderNumOwners = new Map();
  for (const o of orders) {
    if (o.normalizedOrderNumber) {
      const s = orderNumOwners.get(o.normalizedOrderNumber) || new Set();
      s.add(o.companyKey); orderNumOwners.set(o.normalizedOrderNumber, s);
    }
  }
  return {
    clients, orders, junk, orderNumOwners,
    skipped: seed.skipped || [],
    discrepancies: seed.discrepancies || [],
    summary: seed.summary || {},
  };
}

// Pull the CURRENT live DB state the plan diffs against. ALL clients (incl.
// archived, so we can tell "already archived" from "absent") and ALL orders (for
// order-dedup). Lean for speed; we only read here.
async function loadCurrentState() {
  const [clients, orders] = await Promise.all([
    Client.find({}).select('companyKey matchKey companyName clientName stage source archived createdAt').lean(),
    Order.find({}).select('companyKey orderNumber importedFrom archived').lean(),
  ]);
  return { clients, orders };
}

// Adapt a clean-dataset client into the `mapped` shape applyImportToDoc consumes,
// so the field-merge POLICY (fill-blanks-only, promote-up-only stage, log dedup,
// contact merge) is IDENTICAL to the regular importer — no second policy to drift.
// We regenerate the import log line keyed by the COLLAPSED companyKey so a re-run
// dedups cleanly (the seed's raw line was keyed by the full alias string).
function toMapped(c) {
  return {
    companyName: c.companyName,
    clientName: c.clientName || '',
    companyKey: c.companyKey,
    matchKey: c.matchKey,
    area: '',
    address: '',
    interestType: '',
    stage: c.stage,
    tags: c.tags || [],
    dealValue: Number(c.dealValue) || 0,
    provenance: c.source || 'notion',
    phone: c.phone || '',
    email: c.email || '',
    contacts: c.contacts || [],
    lastContact: c.lastContact || null,
    nextFollowUp: c.nextFollowUp || null,
    logs: [
      { kind: 'import', text: reconcileLogText(c), dedupKey: `import:${c.companyKey}` },
      ...(c.notes ? [{ kind: 'note', text: c.notes, dedupKey: `note:${c.companyKey}:${c.notes}` }] : []),
    ],
  };
}

function reconcileLogText(c) {
  const bits = [];
  if (c.statusRaw) bits.push(`status "${c.statusRaw}"`);
  if (c.orderStatusRaw) bits.push(`order status "${c.orderStatusRaw}"`);
  if (c.akas && c.akas.length) bits.push(`also known as ${c.akas.join(', ')}`);
  return `Imported from Notion CRM (reconcile)${bits.length ? ` — ${bits.join(', ')}` : ''}`;
}

// ── GET/POST /api/crm/reconcile/preview ──────────────────────────────────────
// Returns the PLAN the owner reviews — what would be created/updated/archived/
// loaded, the proposed look-alike merges, and the FULL discrepancy list. Writes
// NOTHING. The same plan object powers apply, so preview == reality.
async function reconcilePreview(req, res) {
  try {
    const body = req.body || {};
    const dataset = loadDataset(body);
    const current = await loadCurrentState();
    const plan = buildReconcilePlan(dataset, current, {
      sweepBadImport: body.sweepBadImport !== false, // default ON (undo today's bad import)
    });

    // Slim, owner-friendly projection (names, not full docs). The discrepancy list
    // and counts are surfaced prominently by the UI.
    res.json({
      dryRun: true,
      summary: plan.summary,
      datasetSummary: dataset.summary,
      clientsToCreate: plan.clientsToCreate.map((c) => ({ companyKey: c.companyKey, name: c.companyName, stage: c.stage, leadSource: c.leadSource, dealValue: c.dealValue, akas: c.akas })),
      clientsToUpdate: plan.clientsToUpdate.map((u) => ({ companyKey: u.companyKey, name: u.name, stage: u.mapped.stage })),
      metaAdJunkToArchive: plan.metaAdJunkToArchive.map((j) => ({ companyKey: j.companyKey, name: j.name, present: j.present, alreadyArchived: j.alreadyArchived })),
      otherBadImportToArchive: plan.otherBadImportToArchive,
      ordersToLoad: plan.ordersToLoad.map((o) => ({ orderNumber: o.orderNumber, company: o.companyName, status: o.status, paid: o.paid, totalValue: o.totalValue })),
      ordersAlreadyPresent: plan.ordersAlreadyPresent.length,
      proposedMerges: plan.proposedMerges,
      discrepancies: plan.discrepancies,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── POST /api/crm/reconcile/apply ────────────────────────────────────────────
// Executes the plan. REQUIRES { confirm: true }. Idempotent + reversible.
// Returns a per-section report of what was actually done, plus the batch id.
async function reconcileApply(req, res) {
  try {
    const body = req.body || {};
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to apply without an explicit { confirm: true }. Run the preview first.' });
    }

    const dataset = loadDataset(body);
    const current = await loadCurrentState();
    const plan = buildReconcilePlan(dataset, current, {
      sweepBadImport: body.sweepBadImport !== false,
    });

    // One batch id stamps every record this run touches (created/updated/archived/
    // ordered), so the whole thing is revertible as a unit.
    const batchId = body.batchId || `reconcile-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;

    const report = {
      batchId,
      created: 0, updated: 0,
      metaAdArchived: 0, otherBadImportArchived: 0,
      ordersLoaded: 0, ordersSkipped: plan.ordersAlreadyPresent.length,
      errors: [],
    };

    // 1) Upsert the real clients (create + update), reusing applyImportToDoc's
    //    field policy, then set the reconcile-specific fields (leadSource, akas,
    //    batch id). Identity is companyKey — never a dupe.
    const incoming = [...plan.clientsToCreate, ...plan.clientsToUpdate.map((u) => u.mapped)];
    report.mergedAwaySkipped = [];
    for (const c of incoming) {
      try {
        let doc = await Client.findOne({ companyKey: c.companyKey });
        const isNew = !doc;
        // A record the owner DELIBERATELY merged away (archivedReason 'merged',
        // mergedInto set) must NOT be silently mutated or resurrected by a re-import
        // — its data now lives on the survivor. Skip it and surface it for review.
        if (!isNew && doc.archived && doc.archivedReason === 'merged') {
          report.mergedAwaySkipped.push({ companyKey: c.companyKey, name: c.companyName, mergedInto: doc.mergedInto || '' });
          continue;
        }
        if (!doc) doc = new Client({ companyKey: c.companyKey, matchKey: c.matchKey || '', source: c.source || 'notion' });
        applyImportToDoc(doc, toMapped(c), isNew, { hasOrders: false });
        // Reconcile-specific structured fields (additive; fill-or-set):
        if (c.leadSource && !doc.leadSource) doc.leadSource = c.leadSource;
        if (Array.isArray(c.akas) && c.akas.length) {
          const seen = new Set((doc.akas || []).map((a) => String(a).toLowerCase()));
          for (const a of c.akas) { if (a && !seen.has(String(a).toLowerCase())) { doc.akas.push(a); seen.add(String(a).toLowerCase()); } }
        }
        // A re-import that was previously archived as a bad import comes back.
        if (!isNew && doc.archived && ['replaced', 'bad-import', 'meta-ad-import'].includes(doc.archivedReason)) {
          doc.archived = false; doc.archivedAt = null; doc.archivedReason = '';
        }
        doc.reconcileBatchId = batchId;
        await doc.save();
        if (isNew) report.created++; else report.updated++;
      } catch (err) {
        report.errors.push({ stage: 'client', companyKey: c.companyKey, message: err.message });
      }
    }

    // 2) ARCHIVE the 111 Meta-ad records (soft) — only those PRESENT and not
    //    already archived. Stamp reason + batch id. Never hard-delete.
    const metaKeys = plan.metaAdJunkToArchive.filter((j) => j.present && !j.alreadyArchived).map((j) => j.companyKey);
    if (metaKeys.length) {
      const r = await Client.updateMany(
        { companyKey: { $in: metaKeys }, archived: { $ne: true } },
        { $set: { archived: true, archivedAt: new Date(), archivedReason: 'meta-ad-import', reconcileBatchId: batchId } },
      );
      report.metaAdArchived = r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
    }

    // 3) ARCHIVE other today's-bad-import artifacts (soft).
    const otherKeys = plan.otherBadImportToArchive.map((x) => x.companyKey);
    if (otherKeys.length) {
      const r = await Client.updateMany(
        { companyKey: { $in: otherKeys }, archived: { $ne: true } },
        { $set: { archived: true, archivedAt: new Date(), archivedReason: 'bad-import', reconcileBatchId: batchId } },
      );
      report.otherBadImportArchived = r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
    }

    // 4) LOAD historical orders. Idempotency guard: re-check live by companyKey +
    //    NORMALIZED order number (the SAME signature the plan's ordersToLoad/
    //    ordersAlreadyPresent split uses, so apply == preview) — a stored "#0114"
    //    and our "114" are the same order and won't duplicate.
    const orderSig = (orderNumber) => {
      const n = normalizeOrderNumber(orderNumber);
      return n ? `n:${n}` : `r:${String(orderNumber || '').trim().toLowerCase()}`;
    };
    for (const o of plan.ordersToLoad) {
      try {
        const want = orderSig(o.orderNumber);
        const sameCompany = await Order.find({ companyKey: o.companyKey }).select('orderNumber').lean();
        const dup = sameCompany.some((e) => orderSig(e.orderNumber) === want);
        if (dup) { report.ordersSkipped++; continue; }
        await Order.create({
          orderNumber: o.orderNumber,
          companyName: o.companyName,
          clientName: o.clientName || '',
          status: o.status,
          paid: !!o.paid,
          totalValue: Number(o.totalValue) || 0,
          notes: o.notes || '',
          importedFrom: 'notion',
          reconcileBatchId: batchId,
          activity: [{ kind: 'created', actor: 'reconcile', message: `Historical order #${o.orderNumber} loaded from Notion CRM`, at: new Date() }],
        });
        report.ordersLoaded++;
      } catch (err) {
        report.errors.push({ stage: 'order', orderNumber: o.orderNumber, message: err.message });
      }
    }

    report.summary = plan.summary;
    report.discrepancies = plan.discrepancies;
    res.json({ applied: true, ...report });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── GET /api/crm/reconcile/status ────────────────────────────────────────────
// Has a reconcile EVER been applied? Lets the UI auto-hide the prominent
// "Load / reconcile" action once the data is in (every record a run touches is
// stamped with reconcileBatchId), leaving only a quiet "re-run" affordance. Read
// the most-recent stamped record so we can surface the batch id + when.
async function reconcileStatus(req, res) {
  try {
    const last = await Client.findOne({ reconcileBatchId: { $nin: ['', null] } })
      .sort({ updatedAt: -1 })
      .select('reconcileBatchId updatedAt')
      .lean();
    res.json({
      applied: !!last,
      lastBatchId: last ? (last.reconcileBatchId || '') : '',
      at: last ? (last.updatedAt || null) : null,
    });
  } catch (e) {
    // Status is a nicety — never 500 the UI over it; just say "not applied".
    res.json({ applied: false, lastBatchId: '', at: null, error: e.message });
  }
}

// ── POST /api/crm/reconcile/revert ───────────────────────────────────────────
// Undo a prior apply batch by id: un-archive everything that batch archived, and
// archive (NOT hard-delete) the clients/orders that batch created. Records the
// batch only UPDATED (pre-existing) are left as-is for their owner-visible data,
// but their reconcile stamp is cleared. This is the in-app safety net on top of
// the weekly Drive backup.
async function reconcileRevert(req, res) {
  try {
    const body = req.body || {};
    const batchId = body.batchId;
    if (!batchId) return res.status(400).json({ message: 'Provide the { batchId } to revert.' });
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to revert without an explicit { confirm: true }.' });
    }

    // Un-archive records this batch archived (meta-ad + bad-import).
    const unarch = await Client.updateMany(
      { reconcileBatchId: batchId, archived: true, archivedReason: { $in: ['meta-ad-import', 'bad-import'] } },
      { $set: { archived: false, archivedAt: null, archivedReason: '' } },
    );

    // Archive (soft) the orders this batch created.
    const ordersArch = await Order.updateMany(
      { reconcileBatchId: batchId, archived: { $ne: true } },
      { $set: { archived: true, archivedAt: new Date(), archivedReason: 'manual' } },
    );

    res.json({
      reverted: true,
      batchId,
      clientsUnarchived: unarch.modifiedCount != null ? unarch.modifiedCount : (unarch.nModified || 0),
      ordersArchived: ordersArch.modifiedCount != null ? ordersArch.modifiedCount : (ordersArch.nModified || 0),
      note: 'Clients CREATED by the batch are not auto-removed (to avoid losing any edits made since). Archive them by hand if needed, or restore from the Drive backup.',
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

module.exports = {
  reconcilePreview,
  reconcileApply,
  reconcileRevert,
  reconcileStatus,
  // exported for tests / reuse
  loadDataset,
  toMapped,
};
