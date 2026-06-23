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

// One person at the company. Several may share a single CRM record.
const ContactSchema = new mongoose.Schema({
  name:  { type: String, default: '' },
  role:  { type: String, default: '' },   // "manager", "owner", "buyer", etc.
  phone: { type: String, default: '' },
  email: { type: String, default: '' },
}, { _id: false });

// A single timestamped touch in the relationship history (call, text, email,
// note, imported field-tracker line, etc.). `kind` is free-form so the UI can
// tag entries ('call', 'text', 'email', 'note', 'next-action', 'import', ...).
const LogEntrySchema = new mongoose.Schema({
  at:   { type: Date, default: Date.now },
  text: { type: String, default: '' },
  kind: { type: String, default: '' },
}, { _id: false });

const ClientSchema = new mongoose.Schema({
  companyKey:      { type: String, required: true, unique: true, index: true },
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
  area:         { type: String, default: '' },              // region/state, e.g. "North Jersey", "NY"
  interestType: { type: String, enum: INTEREST_TYPES, default: '' },
  dealValue:    { type: Number, default: 0 },               // estimated/open deal value
  contacts:     { type: [ContactSchema], default: [] },     // people at the company
  log:          { type: [LogEntrySchema], default: [] },    // timestamped touch history
  source:       { type: String, default: '' },              // where the record came from ("field-tracker", "order", "manual", ...)
  tags:         { type: [String], default: [], index: true }, // freeform labels for grouping/filtering ("vip", "promos-only", "wholesale", ...)
  lostReason:   { type: String, default: '' },              // why a deal was marked lost (captured when stage → 'lost')
}, { timestamps: true });

ClientSchema.statics.CRM_STAGES     = CRM_STAGES;
ClientSchema.statics.INTEREST_TYPES = INTEREST_TYPES;

const Client = mongoose.model('Client', ClientSchema);
Client.CRM_STAGES     = CRM_STAGES;
Client.INTEREST_TYPES = INTEREST_TYPES;

module.exports = Client;
