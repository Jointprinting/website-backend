const mongoose = require('mongoose');

// Audit + reversibility record for ONE run of the owner-triggered "reconcile an
// order's scattered numbers down to one canonical #" flow (e.g. Happy Leaf was
// written as #141 in the ledger, #1050/#138 elsewhere — all the SAME order; this
// folds every reference onto one number). Each apply:
//   • records, for every record it renumbers, the collection + _id + the EXACT
//     prior orderNumber string (`changes[].from`) and the new one (`changes[].to`),
//     BEFORE any write — so a revert can put every number back byte-for-byte and the
//     reconcile is NEVER unrecoverable, independent of the weekly Drive backup.
// Revert reads this record and writes each record's orderNumber back to `from`.
//
// Deliberately tiny (just the changed field, not whole-doc snapshots): a renumber
// only ever touches one indexed string field per record, so the inverse is exact
// without a full backup.
const OrderRenumberBatchSchema = new mongoose.Schema({
  batchId:   { type: String, required: true, unique: true, index: true },
  at:        { type: Date, default: Date.now, index: true },
  status:    { type: String, enum: ['applied', 'reverted'], default: 'applied', index: true },
  targetKey: { type: String, default: '' },   // which reconcile target (e.g. 'happyleaf')
  label:     { type: String, default: '' },   // human label for the report/UI
  canonical: { type: String, default: '' },   // the number everything was folded onto
  // One entry per renumbered record: { collection:'Transaction'|'Order', id, from, to }.
  changes:   { type: [mongoose.Schema.Types.Mixed], default: [] },
  count:     { type: Number, default: 0 },
  note:      { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('OrderRenumberBatch', OrderRenumberBatchSchema);
