const mongoose = require('mongoose');

// Audit + reversibility record for ONE run of the owner-triggered "merge duplicate
// transactions" flow — the finance analogue of FinanceRestartBatch, for the
// CROSS-SOURCE duplicate merge (a budget-restart row + a manual/receipt row that are
// the same real payment, drifted apart by ~2 weeks so the restart's date-strict dedup
// missed them). Each apply:
//   • for every merged pair, snapshots BOTH original rows into `originalRows` (a full
//     backup so a revert can restore them byte-for-byte — the merge is therefore NEVER
//     unrecoverable, independent of the weekly Drive backup), and records the
//     survivor's prior field values in `survivorBefore` (so a revert can roll the
//     survivor back to exactly what it was), and
//   • records counts for the report / UI.
// Revert reads this record: it deletes the merged-away rows that no longer exist (they
// were folded into a survivor), restores the snapshotted originals, and rolls each
// survivor's fields back to its pre-merge state.
const FinanceDedupeBatchSchema = new mongoose.Schema({
  batchId:   { type: String, required: true, unique: true, index: true },
  at:        { type: Date, default: Date.now, index: true },
  status:    { type: String, enum: ['applied', 'reverted'], default: 'applied', index: true },
  // Counts for the report / UI.
  merged:    { type: Number, default: 0 },   // number of pairs merged this run
  removed:   { type: Number, default: 0 },   // redundant rows deleted (== merged)
  // FULL backup of every original row involved in a merge (survivor + redundant for
  // each pair), as plain objects (lean docs) — so revert restores them exactly.
  originalRows: { type: [mongoose.Schema.Types.Mixed], default: [] },
  // Per-survivor pre-merge field snapshot: { id, before } where `before` is the small
  // set of fields the merge may have changed (receiptUrl/orderNumber/invoiceNumber/
  // party/description/category/qbSynced/source/mergedFrom/dedupeBatchId). Revert sets
  // these back, so the survivor returns to exactly its pre-merge shape.
  survivorBefore: { type: [mongoose.Schema.Types.Mixed], default: [] },
  note:      { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('FinanceDedupeBatch', FinanceDedupeBatchSchema);
