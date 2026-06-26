const mongoose = require('mongoose');

// Audit + reversibility record for ONE run of the owner-triggered "restart
// finances from my budgets" flow. Each apply:
//   • snapshots the budget-sourced Transaction rows it is about to REPLACE into
//     `replacedRows` (a full backup, so a revert can restore them byte-for-byte —
//     the restart is therefore NEVER unrecoverable, independent of the weekly
//     Drive backup), and
//   • records what it inserted + which manual rows it preserved/dropped.
// Revert reads this record: it deletes the rows this batch inserted (by
// restartBatchId) and re-inserts the snapshotted `replacedRows`.
const FinanceRestartBatchSchema = new mongoose.Schema({
  batchId:   { type: String, required: true, unique: true, index: true },
  at:        { type: Date, default: Date.now, index: true },
  status:    { type: String, enum: ['applied', 'reverted'], default: 'applied', index: true },
  // Counts for the report / UI.
  inserted:  { type: Number, default: 0 },
  replaced:  { type: Number, default: 0 },   // prior budget rows removed (== replacedRows.length)
  preserved: { type: Number, default: 0 },   // manual rows kept
  droppedDuplicates: { type: Number, default: 0 },
  // Headline totals at apply time (for an audit trail).
  totals:    { type: mongoose.Schema.Types.Mixed, default: {} },
  // FULL backup of the budget rows this apply deleted, so revert restores them.
  // Plain objects (the lean docs) — NOT refs, so they survive even if the live
  // rows are gone.
  replacedRows: { type: [mongoose.Schema.Types.Mixed], default: [] },
  note:      { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('FinanceRestartBatch', FinanceRestartBatchSchema);
