const mongoose = require('mongoose');

const VALID_STORES = ['blanks', 'logos', 'mockups'];

const StudioLibraryItemSchema = new mongoose.Schema({
  store:      { type: String, enum: VALID_STORES, required: true },
  name:       { type: String, default: '' },
  data:       { type: String, default: '' },    // base64 for blanks/logos
  thumbnail:  { type: String, default: '' },    // base64 preview thumbnail
  client:     { type: String, default: '' },
  pageState:  { type: mongoose.Schema.Types.Mixed, default: null }, // full page state for mockups
  savedAt:    { type: Number, default: () => Date.now() },
  remoteId:   { type: String, default: '', index: true },           // client-generated UUID for dedup
}, { timestamps: true });

StudioLibraryItemSchema.index({ store: 1, savedAt: -1 });

module.exports = mongoose.model('StudioLibraryItem', StudioLibraryItemSchema);
