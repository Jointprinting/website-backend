const mongoose = require('mongoose');

const BackupLogSchema = new mongoose.Schema({
  kind:   { type: String, enum: ['export', 'import'], required: true, index: true },
  at:     { type: Date, default: Date.now, index: true },
  status: { type: String, enum: ['ok', 'failed'], default: 'ok' },
  collections: { type: mongoose.Schema.Types.Mixed, default: {} },  // { Order: 73, StudioLibraryItem: 142, ... }
  fileCount:   { type: Number, default: 0 },
  totalDocs:   { type: Number, default: 0 },
  sizeBytes:   { type: Number, default: 0 },
  note:        { type: String, default: '' },
});

module.exports = mongoose.model('BackupLog', BackupLogSchema);
