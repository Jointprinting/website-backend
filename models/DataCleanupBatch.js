const mongoose = require('mongoose');

// One reversible "Fix data" run. Before applying any field-level fix, the controller
// snapshots the BEFORE value of every record it will touch into this batch, so a
// revert restores each record exactly. Mirrors FinanceDedupeBatch / the reconcile
// batch pattern: nothing is hard-deleted, every change is undoable by batchId.
const DataCleanupBatchSchema = new mongoose.Schema({
  batchId: { type: String, index: true },
  at:      { type: Date, default: Date.now },
  status:  { type: String, default: 'applied' },   // 'applied' | 'reverted'
  // Each snapshot: { id, before: { ...the fields we changed... } }.
  orders:       { type: [mongoose.Schema.Types.Mixed], default: [] },   // before: { companyKey?, companyName?, clientName? }
  clients:      { type: [mongoose.Schema.Types.Mixed], default: [] },   // before: { companyName, clientName }
  transactions: { type: [mongoose.Schema.Types.Mixed], default: [] },   // before: { orderNumber }
  // Rows ARCHIVED by a duplicate-sale fix: the FULL original document of each removed
  // transaction (the duplicate revenue row + any orphan-order siblings), so a revert
  // re-inserts each at its original _id. Empty unless the run removed a duplicate sale.
  removedTransactions: { type: [mongoose.Schema.Types.Mixed], default: [] },
  counts:  { type: mongoose.Schema.Types.Mixed, default: {} },
});

module.exports = mongoose.model('DataCleanupBatch', DataCleanupBatchSchema);
