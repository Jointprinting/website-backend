const mongoose = require('mongoose');

const VALID_STORES = ['blanks', 'logos', 'mockups'];

const StudioLibraryItemSchema = new mongoose.Schema({
  store:      { type: String, enum: VALID_STORES, required: true },
  name:       { type: String, default: '' },
  data:       { type: String, default: '' },    // base64 for blanks/logos
  thumbnail:  { type: String, default: '' },    // base64 preview thumbnail
  client:     { type: String, default: '' },
  pageState:  { type: mongoose.Schema.Types.Mixed, default: null }, // full page state for mockups
  // MULTI-PAGE mockups: every page (view) of the one mockup file, trimmed like
  // pageState (base64 layers stripped client-side before sync). null = single.
  pages:      { type: mongoose.Schema.Types.Mixed, default: null },
  // Pages 2+'s front composites (shrunk, R2-offloaded like thumbnail/data) so
  // the approval/confirmation surfaces can show every view of the mockup.
  extraViews: { type: [String], default: [] },
  savedAt:    { type: Number, default: () => Date.now() },
  remoteId:   { type: String, default: '', index: true },           // client-generated UUID for dedup
}, { timestamps: true });

StudioLibraryItemSchema.index({ store: 1, savedAt: -1 });

module.exports = mongoose.model('StudioLibraryItem', StudioLibraryItemSchema);
