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
  // The PROJECT this mockup belongs to — the one link, top-level and indexed.
  //
  // It used to live only inside `pageState.projectNumber`, an untyped Mixed blob
  // that could never be queried or indexed. So every project-scoped view loaded
  // the WHOLE library and filtered in JS, and the project↔mockup link was really
  // decided by a fuzzy client-NAME match in the Order Tracker — which meant every
  // project of a long-term client silently accumulated every mockup that client
  // had ever had, and that pile leaked to the client on pre-confirmation approval
  // links. This field is that link, done properly.
  //
  // Matches Order.projectNumber exactly (including sibling suffixes like '22-2'),
  // so `{ store, projectNumber }` is an exact, indexed join. Resolved on save and
  // backfilled for legacy docs — see controllers/studioLibrary.resolveProjectFor.
  projectNumber: { type: String, default: '', index: true },
  // Where a carried-over design came from. A mockup carried into a new project is
  // re-lettered under that project (#000150A → #000200A) so versioning, grouping
  // and per-project isolation all keep working; this remembers the lineage so the
  // history isn't lost. Empty on an original.
  carriedFrom: {
    projectNumber: { type: String, default: '' },
    mockupNum:     { type: String, default: '' },
    at:            { type: Date, default: null },
  },
  // WHICH GARMENT COLOUR this mockup is, as data rather than prose.
  //
  // The mockup NUMBER already says which colourway it is — #000150A and
  // #000150B are two colours of one design (utils/mockupNumbers). What the
  // letter cannot say is WHICH colour, so it lived in the display name
  // ("Tee · Black") and the free-text subtitle ("Gildan 5000, Black"), where
  // nothing could group, label or match on it. The S&S picker had the real
  // values all along and threw them away.
  //
  // Stamped when a colourway is made from an S&S colour; empty on anything made
  // before, or on an uploaded promo shot. Never part of the mockup's identity —
  // the number stays the only thing the client is shown.
  colorway: {
    name:  { type: String, default: '' },   // 'Black', 'Sport Grey'
    code:  { type: String, default: '' },   // S&S colorCode — the stable id
    hex:   { type: String, default: '' },   // swatch, for a colour chip
    style: { type: String, default: '' },   // the S&S style it was taken from
  },
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
  // SOFT DELETE. Deleting a mockup used to be a hard findOneAndDelete that also
  // freed the R2 objects — unrecoverable, on the one collection holding the
  // client artwork the whole business is built on, and reachable from a single
  // click. Everything else here archives (Orders, POs, Vendors, Clients, Deals);
  // this now does too, with the same query guard ClientLogo and Transaction use
  // so an archived row can never leak back into a read. Re-saving the same
  // remoteId revives it (see controllers/studioLibrary.saveItem).
  archived:   { type: Boolean, default: false, index: true },
  archivedAt: { type: Date, default: null },
}, { timestamps: true });

// Archived rows are filtered out of every find/aggregate automatically. Doing it
// by hand at each read site is how one missed site resurrects deleted art in a
// client-facing lookbook — see utils/archiveScope for the full reasoning.
require('../utils/archiveScope').applyLiveScope(StudioLibraryItemSchema);

StudioLibraryItemSchema.index({ store: 1, savedAt: -1 });
// Client-scoped mockup lookups (lookbook picker, CRM design library) filter by
// store + companyKey, newest first — one index serves all three surfaces.
StudioLibraryItemSchema.index({ store: 1, companyKey: 1, savedAt: -1 });
// Project-scoped lookups — the project workspace's Designs panel, the approval
// page, the confirmation/PO PDFs. These all used to scan the entire mockups
// collection and index it in memory to find two or three items; this serves them
// all with an exact match.
StudioLibraryItemSchema.index({ store: 1, projectNumber: 1, savedAt: -1 });

module.exports = mongoose.model('StudioLibraryItem', StudioLibraryItemSchema);
