// controllers/financeDedupe.js
//
// Admin-only endpoints for the owner-triggered "Merge duplicate transactions" flow —
// the cleanup that resolves the CROSS-SOURCE duplicate rows the budget restart left
// behind (a budget-restart copy of a payment + the owner's pre-existing manual/receipt
// copy of the SAME payment, whose dates drifted ~2 weeks apart so the restart's
// date-strict dedup missed them). THIN wrappers around the pure logic in
// services/financeDedupe.js: they load the CURRENT live Transactions, build the plan,
// and (only on an explicit confirm) MERGE each pair into one row — preserving EVERY
// link (receipt, project/order link, invoice #) and removing the redundant row so the
// amount counts ONCE.
//
//   GET/POST /api/finances/dedupe/preview  → the PLAN (no writes; dryRun)
//   POST     /api/finances/dedupe/apply     → execute (requires { confirm: true })
//   POST     /api/finances/dedupe/revert     → undo a batch by id
//   GET      /api/finances/dedupe/status     → has a merge ever been applied?
//
// SAFETY (enforced here + in the pure layer):
//   • Nothing auto-applies. apply requires { confirm: true }.
//   • NEVER deletes a row whose links aren't first folded onto the survivor — a
//     receipt / order link / invoice # is never lost.
//   • Cross-source-ONLY: a pair must be one budget row + one manual/receipt row, so two
//     genuinely-distinct same-source recurring charges can never be merged.
//   • Reversible + recoverable: BOTH original rows of every merged pair are snapshotted
//     into a FinanceDedupeBatch BEFORE any change, the survivor's prior field values are
//     recorded, and the survivor is stamped with the batch id. Revert restores the
//     originals and rolls the survivor back.
//   • Idempotent in spirit: a second apply finds NO pairs (the survivor is now source
//     'merge', the redundant row is gone) → no-op.

const crypto = require('crypto');

const Transaction = require('../models/Transaction');
const FinanceDedupeBatch = require('../models/FinanceDedupeBatch');
const { buildDedupePlan, mergeTransactions } = require('../services/financeDedupe');

// The survivor fields a merge may touch — captured BEFORE the merge so revert can roll
// the survivor back to exactly its pre-merge shape.
const SURVIVOR_FIELDS = [
  'orderNumber', 'invoiceNumber', 'receiptUrl', 'party', 'description', 'category',
  'isCredit', 'qbSynced', 'paymentMethod', 'feeRateOverride', 'source', 'mergedFrom', 'dedupeBatchId',
];

// Pull the CURRENT live ledger rows the plan diffs against — the fields the pure logic
// needs to detect + merge. Lean for the read; the writes target rows by _id.
async function loadCurrentTransactions() {
  return Transaction.find({})
    .select('date type category orderNumber invoiceNumber party description amount isCredit qbSynced paymentMethod feeRateOverride receiptUrl source year restartBatchId dedupeBatchId mergedFrom')
    .lean();
}

// Restrict the plan's pairs to a caller-selected subset (the "Merge this one" button),
// keyed by the pair `key`. No `pairKeys` (or an empty/whitespace array) → all pairs
// (the "Merge all" button). Unknown keys are ignored.
function selectPairs(plan, pairKeys) {
  if (!Array.isArray(pairKeys) || pairKeys.length === 0) return plan.pairs;
  const want = new Set(pairKeys.map((k) => String(k)));
  return plan.pairs.filter((p) => want.has(String(p.key)));
}

// ── GET/POST /api/finances/dedupe/preview ─────────────────────────────────────
async function dedupePreview(req, res) {
  try {
    const transactions = await loadCurrentTransactions();
    const plan = buildDedupePlan(transactions, {});
    res.json({
      dryRun: true,
      summary: plan.summary,
      groups: plan.groups,        // each pair: budget row + manual row + merged result
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── POST /api/finances/dedupe/apply ───────────────────────────────────────────
async function dedupeApply(req, res) {
  try {
    const body = req.body || {};
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to merge without an explicit { confirm: true }. Run the preview first.' });
    }

    const transactions = await loadCurrentTransactions();
    const plan = buildDedupePlan(transactions, {});
    const pairs = selectPairs(plan, body.pairKeys);
    if (!pairs.length) {
      return res.json({ applied: true, merged: 0, removed: 0, note: 'No duplicate pairs to merge.' });
    }

    const batchId = body.batchId || `findedupe-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;

    // 1) SNAPSHOT every original row involved (full backup → reversible) and record the
    //    survivor's pre-merge field values, BEFORE any write. Persist the batch first so
    //    the backup is durable before we mutate/delete anything.
    const survivorIds = pairs.map((p) => p.budget._id);
    const removeIds = pairs.map((p) => p.manual._id);
    const originalRows = await Transaction.find({ _id: { $in: [...survivorIds, ...removeIds] } }).lean();
    const survivorBefore = pairs.map((p) => {
      const before = {};
      const s = (originalRows.find((r) => String(r._id) === String(p.budget._id))) || p.budget;
      for (const f of SURVIVOR_FIELDS) before[f] = s[f];
      return { id: String(p.budget._id), before };
    });

    await FinanceDedupeBatch.create({
      batchId,
      status: 'applied',
      merged: pairs.length,
      removed: removeIds.length,
      originalRows,
      survivorBefore,
      note: 'Merge duplicate transactions (cross-source drift pairs + exact same-source copies).',
    });

    // 2) For each pair: UPDATE the survivor with the unioned fields (stamped with the
    //    batch id) FIRST, then DELETE the redundant row. Updating before deleting means
    //    the receipt/order/invoice is on the survivor before its source row is gone — a
    //    link can never be lost, even if the process is interrupted between the two.
    let merged = 0;
    let removed = 0;
    for (const p of pairs) {
      const { set } = mergeTransactions(p.budget, p.manual);
      await Transaction.findByIdAndUpdate(
        p.budget._id,
        { $set: { ...set, dedupeBatchId: batchId } },
        { new: false, runValidators: true },
      );
      merged += 1;
      const del = await Transaction.deleteOne({ _id: p.manual._id });
      removed += (del.deletedCount != null ? del.deletedCount : (del.n || 0));
    }

    res.json({
      applied: true,
      batchId,
      merged,
      removed,
      summary: plan.summary,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── GET /api/finances/dedupe/status ───────────────────────────────────────────
// Has a duplicate-merge EVER been applied (and not since reverted)? Used by the UI to
// keep the entry point quiet once the ledger is clean. Reads the most-recent APPLIED
// batch.
async function dedupeStatus(req, res) {
  try {
    const last = await FinanceDedupeBatch.findOne({ status: 'applied' })
      .sort({ at: -1 })
      .select('batchId at status merged')
      .lean();
    res.json({
      applied: !!last,
      lastBatchId: last ? (last.batchId || '') : '',
      merged: last ? (last.merged || 0) : 0,
      at: last ? (last.at || null) : null,
    });
  } catch (e) {
    res.json({ applied: false, lastBatchId: '', at: null, error: e.message });
  }
}

// ── POST /api/finances/dedupe/revert ──────────────────────────────────────────
// Undo a prior merge batch by id: re-insert the removed (folded-away) rows from the
// snapshot and roll each survivor's fields back to its pre-merge state. Requires an
// explicit confirm. Idempotent: reverting an already-reverted batch is a no-op.
async function dedupeRevert(req, res) {
  try {
    const body = req.body || {};
    const batchId = body.batchId;
    if (!batchId) return res.status(400).json({ message: 'Provide the { batchId } to revert.' });
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to revert without an explicit { confirm: true }.' });
    }
    const batch = await FinanceDedupeBatch.findOne({ batchId });
    if (!batch) return res.status(404).json({ message: `No finance dedupe batch found for id "${batchId}".` });
    if (batch.status === 'reverted') {
      return res.json({ reverted: true, batchId, alreadyReverted: true, note: 'This batch was already reverted.' });
    }

    // Guard against a STALE revert: if a NEWER applied batch exists, reverting this
    // older one out of order can restore rows that the newer run already re-merged →
    // a resurrected duplicate that double-counts. Revert is an "undo the last merge"
    // action — refuse to undo an older one out of order and point at the latest batch.
    // (Mirrors controllers/financeRestart.restartRevert's newer-batch guard.)
    const newer = await FinanceDedupeBatch.findOne({
      status: 'applied', at: { $gt: batch.at }, batchId: { $ne: batchId },
    }).sort({ at: -1 }).lean();
    if (newer) {
      return res.status(409).json({
        message: `A newer merge (batch ${newer.batchId}) was applied after this one. Revert that one first — undoing an older merge out of order could resurrect a duplicate.`,
        latestBatchId: newer.batchId,
      });
    }

    const snap = Array.isArray(batch.originalRows) ? batch.originalRows : [];
    const survivorBefore = Array.isArray(batch.survivorBefore) ? batch.survivorBefore : [];
    const survivorIds = new Set(survivorBefore.map((s) => String(s.id)));

    // 1) Roll each survivor back to its pre-merge field values (from survivorBefore) —
    //    this strips the folded-in receipt/order/invoice and the merge stamp, returning
    //    it to exactly what it was.
    let restoredSurvivors = 0;
    for (const s of survivorBefore) {
      const set = { ...s.before };
      // Clear the dedupe stamp regardless of what `before` held (defensive).
      set.dedupeBatchId = s.before && s.before.dedupeBatchId ? s.before.dedupeBatchId : '';
      const r = await Transaction.findByIdAndUpdate(s.id, { $set: set }, { new: false });
      if (r) restoredSurvivors += 1;
    }

    // 2) Restore the removed (folded-away) rows — only the ones that were redundant
    //    (NOT the survivors, which still exist). We re-insert each with its ORIGINAL
    //    _id (via an upsert keyed on that _id), so the restore is truly byte-for-byte
    //    (same identity + content) AND idempotent: a retried/interrupted revert can't
    //    stack a second copy — the upsert just re-writes the same _id. Using insertMany
    //    with a fresh _id (the older approach) would duplicate on retry.
    const removedSnaps = snap.filter((r) => !survivorIds.has(String(r._id)));
    let restoredRemoved = 0;
    for (const r of removedSnaps) {
      // Strip _id/__v from the payload (the filter supplies _id on insert) and re-write
      // the row at its original _id. upsert makes the retry idempotent.
      const { __v, _id, ...rest } = r;
      await Transaction.updateOne({ _id }, { $set: rest }, { upsert: true });
      restoredRemoved += 1;
    }

    batch.status = 'reverted';
    await batch.save();

    res.json({
      reverted: true,
      batchId,
      restoredSurvivors,   // survivors rolled back to pre-merge state
      restoredRemoved,     // folded-away rows put back
      note: 'The merge was undone: each survivor was rolled back and the merged-away rows restored from the batch backup.',
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

module.exports = {
  dedupePreview,
  dedupeApply,
  dedupeRevert,
  dedupeStatus,
  // exported for tests / reuse
  selectPairs,
  SURVIVOR_FIELDS,
};
