// controllers/financeRestart.js
//
// Admin-only endpoints for the owner-triggered "Restart finances from my budgets"
// flow — the finance analogue of controllers/crmReconcile.js. THIN wrappers around
// the pure logic in services/financeRestart.js: they load the committed seed
// (data/financeLedgerSeed.json, built by scripts/buildFinanceSeed.js) + the CURRENT
// live Transactions, build the plan, and (only on an explicit confirm) apply it.
//
//   GET/POST /api/finances/restart/preview  → the PLAN (no writes; dryRun)
//   POST     /api/finances/restart/apply     → execute (requires { confirm: true })
//   POST     /api/finances/restart/revert     → undo a batch by id
//
// SAFETY (enforced here + in the pure layer):
//   • Nothing auto-applies. apply requires { confirm: true }.
//   • REPLACE only the budget-sourced rows (source:'budget'); PRESERVE every manual
//     row the budget doesn't represent (dedup by date+amount+normalized order#), so
//     the owner's latest in-app entries survive the restart.
//   • Reversible + recoverable: the rows being replaced are snapshotted into a
//     FinanceRestartBatch BEFORE deletion, and every inserted row is stamped with
//     the batch id. Revert restores the snapshot and removes the inserted rows.
//   • Idempotent: a second apply replaces this run's budget rows with the same seed
//     → the ledger converges (no duplicates).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Transaction = require('../models/Transaction');
const FinanceRestartBatch = require('../models/FinanceRestartBatch');
const { buildRestartPlan, seedRowToDoc } = require('../services/financeRestart');

const SEED_PATH = path.join(__dirname, '..', 'data', 'financeLedgerSeed.json');
const KNOWN_PATH = path.join(__dirname, '..', 'data', 'financeKnownDiscrepancies.json');

// Load the committed finance seed (built from the owner's budget trackers). Throws
// a clear, actionable error if it's missing so the owner knows to re-run the
// builder rather than seeing a generic 500.
function loadSeed() {
  let seed;
  try {
    seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  } catch (e) {
    throw new Error('The finance ledger seed (data/financeLedgerSeed.json) is missing or unreadable. Re-run scripts/buildFinanceSeed.js against the budget trackers.');
  }
  if (!seed || !Array.isArray(seed.rows)) throw new Error('The finance ledger seed is malformed (no rows[]). Re-run scripts/buildFinanceSeed.js.');
  return seed;
}

function loadKnownDiscrepancies() {
  try { return JSON.parse(fs.readFileSync(KNOWN_PATH, 'utf8')); } catch (_) { return []; }
}

// Pull the CURRENT live ledger rows the plan diffs against — only the fields the
// pure logic needs (source decides replace-vs-preserve; date/amount/orderNumber are
// the dedup signature). Lean for speed; we only read here.
async function loadCurrentState() {
  const transactions = await Transaction.find({})
    .select('date type category orderNumber party description amount isCredit qbSynced source year restartBatchId')
    .lean();
  return { transactions };
}

function buildPlan(opts = {}) {
  const seed = loadSeed();
  return {
    seed,
    plan: null,
    cogsCategories: Transaction.COGS_CATEGORIES,
    knownDiscrepancies: loadKnownDiscrepancies(),
    ...opts,
  };
}

// ── GET/POST /api/finances/restart/preview ───────────────────────────────────
async function restartPreview(req, res) {
  try {
    const seed = loadSeed();
    const current = await loadCurrentState();
    const plan = buildRestartPlan(seed, current, {
      cogsCategories: Transaction.COGS_CATEGORIES,
      knownDiscrepancies: loadKnownDiscrepancies(),
    });
    // Slim, owner-friendly projection (no full row arrays from preserve).
    res.json({
      dryRun: true,
      summary: plan.summary,
      totals: plan.totals,
      perCategory: plan.perCategory,
      byOrder: plan.byOrder,
      discrepancies: plan.discrepancies,
      // A small sample of the manual rows that would be preserved, so the owner can
      // SEE that their recent hand entries survive (not the whole array).
      preservedSample: (plan.preserve.toPreserve || []).slice(0, 25).map(slimRow),
      droppedDuplicateSample: (plan.preserve.droppedDuplicates || []).slice(0, 25).map(slimRow),
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

function slimRow(t) {
  return {
    date: t.date, type: t.type, category: t.category, orderNumber: t.orderNumber,
    party: t.party, description: t.description, amount: t.amount, source: t.source,
  };
}

// ── POST /api/finances/restart/apply ─────────────────────────────────────────
async function restartApply(req, res) {
  try {
    const body = req.body || {};
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to apply without an explicit { confirm: true }. Run the preview first.' });
    }

    const seed = loadSeed();
    const current = await loadCurrentState();
    const plan = buildRestartPlan(seed, current, {
      cogsCategories: Transaction.COGS_CATEGORIES,
      knownDiscrepancies: loadKnownDiscrepancies(),
    });

    const batchId = body.batchId || `finrestart-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;

    // 1) SNAPSHOT the budget rows we're about to replace (full backup → reversible).
    //    Re-read the actual docs (with _id) so the snapshot can be restored verbatim.
    const toDeleteIds = (plan.preserve.toDelete || []).map((t) => t._id).filter(Boolean);
    let replacedRows = [];
    if (toDeleteIds.length) {
      replacedRows = await Transaction.find({ _id: { $in: toDeleteIds } }).lean();
    }

    // 2) Persist the batch record (status applied) BEFORE the destructive step, so
    //    a crash mid-apply still leaves the backup recoverable.
    await FinanceRestartBatch.create({
      batchId,
      status: 'applied',
      inserted: plan.preserve.toInsertCount,
      replaced: replacedRows.length,
      preserved: plan.preserve.preservedCount,
      droppedDuplicates: plan.preserve.droppedDuplicateCount,
      totals: plan.totals,
      replacedRows,
      note: 'Restart finances from owner budget trackers.',
    });

    // 3) DELETE the prior budget rows (replaced). Manual rows are never matched here
    //    (we only delete by the exact ids the plan flagged as source:'budget').
    let deleted = 0;
    if (toDeleteIds.length) {
      const r = await Transaction.deleteMany({ _id: { $in: toDeleteIds } });
      deleted = r.deletedCount != null ? r.deletedCount : (r.n || 0);
    }

    // 4) INSERT the seed rows (the verified ledger), stamped with source 'budget' +
    //    the batch id. Manual rows that duplicate a budget row were already excluded
    //    from "preserve" (the budget version wins) — but they LIVE in the DB still;
    //    we don't touch them here (dropping them is the owner's call, surfaced as a
    //    discrepancy). The budget insert is the canonical copy going forward.
    const docs = seed.rows.map((r) => seedRowToDoc(r, batchId));
    const inserted = await Transaction.insertMany(docs, { ordered: false });

    res.json({
      applied: true,
      batchId,
      inserted: inserted.length,
      replaced: deleted,
      preserved: plan.preserve.preservedCount,
      droppedDuplicates: plan.preserve.droppedDuplicateCount,
      totals: plan.totals,
      summary: plan.summary,
      discrepancies: plan.discrepancies,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── POST /api/finances/restart/revert ────────────────────────────────────────
// Undo a prior apply batch by id: delete the rows that batch inserted (by
// restartBatchId) and RESTORE the snapshotted budget rows it replaced. Requires an
// explicit confirm. Idempotent: reverting an already-reverted batch is a no-op.
async function restartRevert(req, res) {
  try {
    const body = req.body || {};
    const batchId = body.batchId;
    if (!batchId) return res.status(400).json({ message: 'Provide the { batchId } to revert.' });
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to revert without an explicit { confirm: true }.' });
    }
    const batch = await FinanceRestartBatch.findOne({ batchId });
    if (!batch) return res.status(404).json({ message: `No finance restart batch found for id "${batchId}".` });
    if (batch.status === 'reverted') {
      return res.json({ reverted: true, batchId, alreadyReverted: true, note: 'This batch was already reverted.' });
    }

    // 1) Remove the rows this batch inserted.
    const delRes = await Transaction.deleteMany({ restartBatchId: batchId, source: 'budget' });
    const removed = delRes.deletedCount != null ? delRes.deletedCount : (delRes.n || 0);

    // 2) Restore the snapshotted budget rows it had replaced (strip _id so Mongo
    //    re-mints; their content — including the original source — is preserved).
    let restored = 0;
    const snap = Array.isArray(batch.replacedRows) ? batch.replacedRows : [];
    if (snap.length) {
      const docs = snap.map((r) => { const { _id, __v, ...rest } = r; return rest; });
      const ins = await Transaction.insertMany(docs, { ordered: false });
      restored = ins.length;
    }

    batch.status = 'reverted';
    await batch.save();

    res.json({
      reverted: true, batchId,
      removed,            // inserted-by-this-batch rows deleted
      restored,           // prior budget rows put back
      note: 'The restart was undone: its inserted rows were removed and the prior budget rows restored from the batch backup.',
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

module.exports = {
  restartPreview,
  restartApply,
  restartRevert,
  // exported for tests / reuse
  loadSeed,
  buildPlan,
};
