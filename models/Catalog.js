// models/Catalog.js
//
// Catalog metadata stored in Mongo. The PDF itself lives in GridFS — we keep
// only the ObjectId reference here so the document stays small. Style presets
// are referenced by ID; the actual visual rendering happens client-side from
// the shared catalogPresets module (frontend src/common/catalogPresets.js).
const mongoose = require('mongoose');

const CATALOG_PRESETS = [
  'default',     // emoji + simple title
  'patriotic',   // US flag + alternating red/blue words
  'holiday',     // snowflake + winter gradient (red/green/gold)
  'canopy',      // leaf + deep green gradient — built for dispensary catalogs
  'prestige',    // gold accent + serif italic title — premium / exclusive lines
  'neon',        // cyberpunk gradient + mono title — streetwear / youth lines
];

const CatalogSchema = new mongoose.Schema({
  title:       { type: String, required: true },
  description: { type: String, default: '' },
  tags:        [{ type: String }],

  // Visual styling
  stylePreset: { type: String, enum: CATALOG_PRESETS, default: 'default' },
  accentColor: { type: String, default: '' }, // optional override of the preset's default accent
  emoji:       { type: String, default: '📘' }, // only used by 'default' preset

  // PDF storage — GridFS reference in the shared 'images' bucket
  pdfFileId:   { type: mongoose.Schema.Types.ObjectId },
  pdfFileName: { type: String, default: '' }, // original filename, used for downloads
  pdfFileSize: { type: Number, default: 0 },

  // Ordering and publish state
  sortOrder:   { type: Number, default: 0 },
  isPublished: { type: Boolean, default: true },

  // Analytics — incremented by the public PDF stream route
  viewCount:     { type: Number, default: 0 },
  downloadCount: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

CatalogSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

CatalogSchema.statics.PRESETS = CATALOG_PRESETS;

module.exports = mongoose.model('Catalog', CatalogSchema);
