const mongoose = require('mongoose');

// Audit + reversibility record for ONE run of the owner-triggered "Rebuild printers
// from Drive" flow (controllers/vendorRebuild). Mirrors FinanceRestartBatch. Each
// apply:
//   • SNAPSHOTS the in-app Vendor + PurchaseOrder rows it is about to ARCHIVE into
//     `archivedVendors` / `archivedPos` (their full pre-change lean docs), so a
//     revert restores them exactly — the rebuild is therefore never unrecoverable,
//     independent of the weekly Drive backup; and
//   • records the ids it CREATED (vendors + POs), so revert can soft-archive them.
// Revert reads this record: it un-archives the snapshotted rows and archives the
// rows this batch created. Everything is archive-not-delete (recoverable).
const VendorRebuildBatchSchema = new mongoose.Schema({
  batchId: { type: String, required: true, unique: true, index: true },
  at:      { type: Date, default: Date.now, index: true },
  status:  { type: String, enum: ['applied', 'reverted'], default: 'applied', index: true },

  // Counts for the report / UI.
  vendorsCreated: { type: Number, default: 0 },
  vendorsUpdated: { type: Number, default: 0 },
  posLoaded:      { type: Number, default: 0 },
  vendorsArchived:{ type: Number, default: 0 },
  posArchived:    { type: Number, default: 0 },
  preservedPos:   { type: Number, default: 0 },

  // Ids this batch CREATED (so revert can soft-archive them).
  createdVendorIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
  createdPoIds:     { type: [mongoose.Schema.Types.ObjectId], default: [] },

  // FULL backup of the rows this apply ARCHIVED, so revert un-archives them (and
  // can restore any fields it changed). Plain objects (lean docs), not refs, so
  // they survive even if the live rows change.
  archivedVendors: { type: [mongoose.Schema.Types.Mixed], default: [] },
  archivedPos:     { type: [mongoose.Schema.Types.Mixed], default: [] },

  note: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('VendorRebuildBatch', VendorRebuildBatchSchema);
