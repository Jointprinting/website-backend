const mongoose = require('mongoose');

const VALID_STORES = ['blanks', 'logos', 'mockups'];

const StudioLibraryItemSchema = new mongoose.Schema({
  store:      { type: String, enum: VALID_STORES, required: true },
  name:       { type: String, default: '' },
  data:       { type: String, default: '' },    // base64 for blanks/logos
  thumbnail:  { type: String, default: '' },    // base64 preview thumbnail
  client:     { type: String, default: '' },
  // Canonical company key — the SAME derivation Order.companyKey uses
  // (utils/companyKey.deriveCompanyKey). The unifying join for the "visuals of
  // the job" area: a lookbook's picker, the CRM design library, and any
  // client-scoped mockup view all filter on THIS instead of the old fuzzy
  // client-name / mockup-number guessing. Derived on save from `client`;
  // backfilled on existing docs from the order that references the mockup #.
  companyKey: { type: String, default: '', index: true },
  pageState:  { type: mongoose.Schema.Types.Mixed, default: null }, // full page state for mockups
  // MULTI-PAGE mockups: every page (view) of the one mockup file, trimmed like
  // pageState (base64 layers stripped client-side before sync). null = single.
  pages:      { type: mongoose.Schema.Types.Mixed, default: null },
  // Pages 2+'s front composites (shrunk, R2-offloaded like thumbnail/data) so
  // the approval/confirmation surfaces can show every view of the mockup.
  extraViews: { type: [String], default: [] },
  // Pages 2+'s BACK composites — the parallel of extraViews for the back of each
  // extra page. Previously these were never persisted (the sync trimmed every
  // page's back and only extraViews/front survived to the cloud), so on any
  // cross-device / post-wipe reload the back of page 2+ was permanently lost.
  // Stored the same way (R2 URLs). Old docs simply have none → back-compat.
  extraBackViews: { type: [String], default: [] },
  savedAt:    { type: Number, default: () => Date.now() },
  remoteId:   { type: String, default: '', index: true },           // client-generated UUID for dedup
}, { timestamps: true });

StudioLibraryItemSchema.index({ store: 1, savedAt: -1 });
// Client-scoped mockup lookups (lookbook picker, CRM design library) filter by
// store + companyKey, newest first — one index serves all three surfaces.
StudioLibraryItemSchema.index({ store: 1, companyKey: 1, savedAt: -1 });

module.exports = mongoose.model('StudioLibraryItem', StudioLibraryItemSchema);
