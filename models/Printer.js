// models/Printer.js
//
// The PRINTER NETWORK — contract printers the owner routes jobs through
// (Heritage in PA first; more as the network grows). Each doc carries the
// printer's home state (the nexus fact the quoter's ship-to check rides on:
// the printer's state and the job's ship-to state must differ), what they can
// print, and their full scraped price catalog (Mixed — each printer's PDF has
// its own shape; the quoter reads sections it understands and ignores the rest).

const mongoose = require('mongoose');

// A person at the printer the owner sends POs to. Editable in-app (add / change
// / remove) — the seed loads the main one from the sheet, the owner refines.
// `primary` is the default recipient the PO builder proposes; at most one.
const printerContactSchema = new mongoose.Schema({
  name:    { type: String, default: '' },
  email:   { type: String, default: '' },
  role:    { type: String, default: '' },   // 'orders', 'art', ...
  primary: { type: Boolean, default: false },
}, { _id: true });

const printerSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },  // slug, e.g. 'heritage'
  name:  { type: String, required: true },
  state: { type: String, default: '' },                   // USPS code, e.g. 'PA'
  location: { type: String, default: '' },                // "Warminster, PA"
  // Freeform reference block (phone / drop-ship address / distributor) seeded
  // from the sheet. The structured, PO-addressable people live in `contacts`.
  contact:  { type: mongoose.Schema.Types.Mixed, default: null },
  contacts: { type: [printerContactSchema], default: [] },
  // DERIVED from the catalog's priced sections (see utils/printerCatalog
  // capabilitiesFromCatalog) on every catalog write — one source of truth, not a
  // hand-typed list that can drift. Canonical: 'screen_printing' | 'embroidery' |
  // 'dtg' | 'dtf' | 'digital_squeegee' | 'digitally_printed_media' | 'personalization'.
  capabilities: { type: [String], default: [] },
  // The price catalog (data/printerCatalog-<key>.json is the INITIAL import; the
  // in-Studio Printer Catalog editor writes it after that). Shape varies per
  // printer — Mixed — so the write path validates the `model` tag per section
  // (utils/printerCatalog) rather than a fixed schema. The boot seed is
  // insert-only ($setOnInsert) so an app edit is never clobbered by a re-deploy.
  catalog: { type: mongoose.Schema.Types.Mixed, default: null },
  // Sections the owner soft-archived (archive-not-delete): moved OUT of `catalog`
  // so the Quoter never prices them, kept here recoverable. { <sectionKey>: <section> }.
  catalogArchive: { type: mongoose.Schema.Types.Mixed, default: undefined },
  // Audit: who last edited this printer in the app, and when. catalogLog is a
  // capped who/what/when trail of price-book edits (newest last).
  editedAt: { type: Date, default: null },
  editedBy: { type: String, default: '' },
  catalogLog: { type: [{ at: Date, by: String, section: String, action: String, _id: false }], default: [] },
  catalogEffective: { type: String, default: '' },        // e.g. '2025-01-01' (the sheet's own effective date)
  // When THIS pricing was captured into the system (YYYY-MM-DD). Drives the
  // yearly "re-verify with the printer's contact" review nudge — a price sheet
  // a year old is stale until the owner confirms it still holds.
  capturedOn: { type: String, default: '' },
  // Set when the owner confirms the pricing is still current (a re-verify).
  // Falls back to capturedOn when never re-verified. See pricingReviewDue().
  pricingReviewedOn: { type: String, default: '' },
  sourcePdfUrl: { type: String, default: '' },            // the original sheet, for spot-checking autoquotes
  notes:  { type: String, default: '' },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
});

// Is this printer's pricing due for its yearly re-verify? True when the last
// time it was captured/confirmed is more than a year before `asOf`. Pure +
// date-only so it's trivially testable and timezone-agnostic.
printerSchema.statics.pricingReviewDue = function (printer, asOf = new Date()) {
  const stamp = (printer && (printer.pricingReviewedOn || printer.capturedOn)) || '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(stamp);
  if (!m) return false; // no capture date on record (e.g. legacy Heritage) — never nag
  const captured = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const oneYearLater = new Date(captured.getFullYear() + 1, captured.getMonth(), captured.getDate());
  return asOf >= oneYearLater;
};

module.exports = mongoose.model('Printer', printerSchema);
