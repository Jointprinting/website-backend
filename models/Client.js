const mongoose = require('mongoose');

// One profile per unique company, keyed by the same companyKey the rest of
// the system uses. Stores the per-client info that should auto-fill on every
// new project for that client (default printer, supplier, markup) plus
// permanent CRM-style notes (payment terms, preferences, contact info).
//
// This is ALSO the unified CRM company record: the app's single source of
// truth per company. The CRM fields below were added additively — every
// pre-existing field/behavior (order-default auto-fill in controllers/orders.js
// via getDefaultsFor, get-or-create in controllers/clients.js) is unchanged.

// Sales pipeline. Default 'lead' so a freshly-bootstrapped record (e.g. one
// auto-created from an order) starts at the top of the funnel.
const CRM_STAGES = ['lead', 'contacted', 'quoting', 'sampling', 'won', 'customer', 'lost', 'dormant'];

// What the company is interested in. '' = unknown/unset.
const INTEREST_TYPES = ['', 'promos', 'apparel', 'both'];

// Structured, FILTERABLE lead-source enum (where the relationship originated).
// '' = unknown/unset (the default). Kept byte-for-byte in sync with the
// LEAD_SOURCES list in utils/fieldTrackerImport.js, which is the single place the
// raw "Source" text is normalized into one of these values. Indexed so the CRM
// list/pipeline can filter by it cheaply.
const LEAD_SOURCES = ['', 'Website', 'Referral', 'Event', 'Social Media',
  'Cold Outreach', 'Partnership', 'Advertising', 'Organic Search'];

// One person at the company. Several may share a single CRM record.
// `isPrimary` is the ★ main contact: at most ONE per record (the PATCH sanitizer
// enforces it), and starring mirrors that person's phone/email to the legacy
// top-level fields — which is what Call/Text/Email, the rows, Today, and the
// heads-up feed all read (primaryPhone/primaryEmail) — so re-pointing the whole
// ecosystem at a new person is a single star tap.
const ContactSchema = new mongoose.Schema({
  name:  { type: String, default: '' },
  role:  { type: String, default: '' },   // "manager", "owner", "buyer", etc.
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
  isPrimary: { type: Boolean, default: false },
}, { _id: false });

// A single timestamped touch in the relationship history (call, text, email,
// note, imported field-tracker line, etc.). `kind` is free-form so the UI can
// tag entries ('call', 'text', 'email', 'note', 'next-action', 'import', ...).
//
// NOTE on `_id`: each entry carries its own Mongo ObjectId (the default). This
// is the stable handle the "delete one note" endpoint targets — the owner asked
// to be able to remove a single log line from a client card. Pre-existing
// entries written while this schema had `{ _id: false }` have NO id; the delete
// endpoint falls back to delete-by-index for those, so nothing is stranded.
const LogEntrySchema = new mongoose.Schema({
  at:   { type: Date, default: Date.now },
  text: { type: String, default: '' },
  kind: { type: String, default: '' },
  // Stable identity for an auto-generated entry (e.g. the import line), so a
  // re-import can recognize "I already wrote this" and skip it instead of piling
  // up near-duplicate rows. Empty for normal human-logged touches.
  dedupKey: { type: String, default: '' },
});

const ClientSchema = new mongoose.Schema({
  companyKey:      { type: String, required: true, unique: true, index: true },
  // Fuzzy grouping key (corp-suffix/apostrophe/punct stripped) used ONLY by the
  // duplicate-finder/merge tooling — NOT identity. companyKey stays the identity
  // that lines up with Orders. Indexed so /duplicates can group by it cheaply.
  matchKey:        { type: String, default: '', index: true },
  companyName:     { type: String, default: '' },
  clientName:      { type: String, default: '' },
  email:           { type: String, default: '' },
  phone:           { type: String, default: '' },
  paymentTerms:    { type: String, default: '' },     // "Net 15", "50% upfront", etc.
  defaultPrinter:  { type: String, default: '' },
  defaultSupplier: { type: String, default: '' },
  defaultMarkup:   { type: Number, default: 0 },      // 0 = no default
  notes:           { type: String, default: '' },     // sticky internal notes that follow the client across projects

  // ── CRM fields (additive) ──
  stage:        { type: String, enum: CRM_STAGES, default: 'lead', index: true },
  nextFollowUp: { type: Date, default: null, index: true }, // when to call/contact next ("who do I call today")
  lastContact:  { type: Date, default: null },              // when we last touched this company
  // EXACT street address — the owner found "Area" (a vague region) useless and
  // asked for a real address instead. `area` is kept below for back-compat (so
  // stored regions aren't lost) but is no longer the field we center on; the
  // detail card edits `address`.
  address:      { type: String, default: '' },              // exact street address, e.g. "123 Main St, Newark NJ 07102"
  area:         { type: String, default: '' },              // LEGACY region/state, e.g. "North Jersey", "NY" (kept for back-compat)
  interestType: { type: String, enum: INTEREST_TYPES, default: '' },
  dealValue:    { type: Number, default: 0 },               // estimated/open deal value
  contacts:     { type: [ContactSchema], default: [] },     // people at the company
  log:          { type: [LogEntrySchema], default: [] },    // timestamped touch history
  source:       { type: String, default: '' },              // where the record came from ("field-tracker", "order", "manual", ...)
  // Structured, filterable origin of the relationship. Distinct from `source`
  // (the record's import provenance); this is the SALES lead source the owner
  // filters the pipeline by. One of LEAD_SOURCES; '' when unknown.
  leadSource:   { type: String, enum: LEAD_SOURCES, default: '', index: true },
  // Alternate names this ONE company also goes by — populated when an alias-style
  // cell ("Happy Leaf / One Green Leaf / The Healing Side") is collapsed into a
  // single client. Keeps the other names searchable/visible without spawning
  // duplicate cards. Primary stays companyName/companyKey.
  akas:         { type: [String], default: [] },
  tags:         { type: [String], default: [], index: true }, // freeform labels for grouping/filtering ("vip", "promos-only", "wholesale", ...)
  lostReason:   { type: String, default: '' },              // why a deal was marked lost (captured when stage → 'lost')
  // Hard email opt-out (CAN-SPAM). Set by the public outreach unsubscribe route
  // (or the owner); the outreach engine refuses to email a company with this
  // set, no matter what campaign it's enrolled in. Never cleared automatically.
  doNotEmail:   { type: Boolean, default: false, index: true },

  // Soft-delete. NOTHING in the CRM is ever hard-deleted — archive a record and
  // it drops out of every working surface (today/dashboard/pipeline/calendar/
  // the default Companies list) while all of its data (orders link by
  // companyKey, log, contacts) is fully preserved and restorable. Set by the
  // archive endpoint, the merge endpoint (on the merged-away record), and the
  // import 'replace' mode (on stale pure-import records).
  archived:     { type: Boolean, default: false, index: true },
  archivedAt:   { type: Date, default: null },
  archivedReason: { type: String, default: '' },            // 'merged', 'replaced', 'dead-cleanup', 'manual', 'meta-ad-import', 'bad-import'
  mergedInto:   { type: String, default: '' },              // survivor companyKey when archivedReason === 'merged'

  // Reconcile audit/revert handle. Every record TOUCHED by a single run of the
  // owner-triggered data reconcile (created, updated, or archived) is stamped with
  // that run's batch id, so the whole batch is identifiable and reversible as a
  // unit. Empty for records the reconcile never touched.
  reconcileBatchId: { type: String, default: '', index: true },
}, { timestamps: true });

ClientSchema.statics.CRM_STAGES     = CRM_STAGES;
ClientSchema.statics.INTEREST_TYPES = INTEREST_TYPES;
ClientSchema.statics.LEAD_SOURCES   = LEAD_SOURCES;

const Client = mongoose.model('Client', ClientSchema);
Client.CRM_STAGES     = CRM_STAGES;
Client.INTEREST_TYPES = INTEREST_TYPES;
Client.LEAD_SOURCES   = LEAD_SOURCES;

module.exports = Client;
