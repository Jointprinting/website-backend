// models/Lookbook.js
//
// A Lookbook is a first-class, persisted, SHAREABLE artifact — the curated
// set of mockups a client reviews (replacing the PDF that used to dead-end
// on the owner's device). It is the first hard link between the Mockup
// Studio's library and the CRM: keyed by companyKey (like ClientLogo), with
// an ordered list of mockup references by remoteId (the sync-stable id the
// Studio's device sync upserts by — never the device-local IndexedDB id).
//
// Lifecycle: draft (owner curating) → shared (client link live) → archived.
// Sharing mints a token exactly like the approval flow's approvalToken; the
// public gallery lives at /lookbook/:id?token=… and client reactions land in
// `feedback` (per-mockup 👍/👎 + comments — the "show me more" iteration
// rounds, structured at last). Money approval stays on the confirmation —
// a lookbook never approves anything.

const mongoose = require('mongoose');

const LookbookFeedbackSchema = new mongoose.Schema({
  mockupRemoteId: { type: String, default: '' },   // '' = about the whole lookbook
  reaction:       { type: String, enum: ['up', 'down', ''], default: '' },
  comment:        { type: String, default: '' },
  by:             { type: String, default: '' },   // name the client typed on the gallery
  at:             { type: Date, default: Date.now },
  seenAt:         { type: Date, default: null },   // owner acknowledged (drives the hub signal)
});

const LookbookSchema = new mongoose.Schema({
  companyKey:  { type: String, required: true, index: true },
  companyName: { type: String, default: '' },
  // Optional project tie — a lookbook usually precedes the order, so this is
  // filled in when the deal reaches quoting and stays useful for history.
  projectNumber: { type: String, default: '', index: true },

  title:    { type: String, default: '' },
  subtitle: { type: String, default: '' },

  // Ordered pages. remoteId → StudioLibraryItem (store 'mockups').
  mockups: [{
    remoteId: { type: String, required: true },
    caption:  { type: String, default: '' },
  }],

  // Presentation — mirrors the server PDF generator's options
  // (controllers/lookbookPdf.js pickLayout vocabulary).
  layout:     { type: String, enum: ['auto', 'editorial', 'grid'], default: 'auto' },
  showBack:   { type: Boolean, default: true },
  showLabels: { type: Boolean, default: true },

  status: { type: String, enum: ['draft', 'shared', 'archived'], default: 'draft' },
  // Stamped when status flips to 'archived' (cleared on restore) — the clock
  // for the 60-day archive auto-purge (services/archivePurge.js). Lookbooks
  // are presentation artifacts, so unlike money records they DO hard-delete
  // after the owner's grace window.
  archivedAt: { type: Date, default: null },

  // Share link (same shape as Order.approvalToken).
  shareToken:          { type: String, default: '', index: true },
  shareTokenExpiresAt: { type: Date, default: null },
  sharedAt:            { type: Date, default: null },
  lastViewedAt:        { type: Date, default: null },  // last client open
  viewCount:           { type: Number, default: 0 },   // throttled client visits (one / 10 min)
  // Throttle stamp for the feedback heads-up email (the hub signal is the
  // durable surface; the email is a courtesy, never a flood).
  lastFeedbackNotifiedAt: { type: Date, default: null },

  feedback: { type: [LookbookFeedbackSchema], default: [] },

  // "Request pricing" submissions from the public gallery — the durable record
  // (the actionable artifact is the quote-stage project each one seeds; its
  // number is stored here so the builder can jump to it).
  lastPricingRequestAt: { type: Date, default: null },   // throttle stamp
  pricingRequests: [{
    at:      { type: Date, default: Date.now },
    by:      { type: String, default: '' },
    email:   { type: String, default: '' },
    phone:   { type: String, default: '' },
    shipTo:  { type: String, default: '' },
    note:    { type: String, default: '' },
    picks:   [{ remoteId: String, name: String, qty: Number, _id: false }],
    projectNumber: { type: String, default: '' },
    _id: false,
  }],
}, { timestamps: true });

LookbookSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model('Lookbook', LookbookSchema);
