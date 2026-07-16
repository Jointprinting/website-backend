// models/ContactSubmission.js
//
// We persist every contact submission to Mongo, then send the email.
// That way you never lose a lead because SMTP hiccupped.
//
// Adds CRM-style fields: `status` (lifecycle of a lead) and `notesAdmin`
// (internal notes only visible in the studio).

const mongoose = require('mongoose');

// Lead lifecycle — ONE shared enum (the union), with a per-source subset the
// UI offers so each brand's inbox reads as its own pipeline:
//   contact  (JP merch):  new → contacted → quoted → won / lost
//   webworks (sites):     new → contacted → preview-built → preview-sent → live / churned / lost
//   atom     (studio):    new → contacted → demo-booked → scoped → onboarding → live / churned / lost
// 'spam' is shared. The frontend mirrors STATUSES_BY_SOURCE in
// src/screens/studio/_submissions.js — keep them in sync.
const STATUSES = [
  'new', 'contacted', 'quoted', 'won', 'lost', 'spam',
  // webworks pipeline
  'preview-built', 'preview-sent', 'live', 'churned',
  // atom pipeline ('live'/'churned' shared with webworks)
  'demo-booked', 'scoped', 'onboarding',
];
const STATUSES_BY_SOURCE = {
  contact:  ['new', 'contacted', 'quoted', 'won', 'lost', 'spam'],
  webworks: ['new', 'contacted', 'preview-built', 'preview-sent', 'live', 'churned', 'lost', 'spam'],
  atom:     ['new', 'contacted', 'demo-booked', 'scoped', 'onboarding', 'live', 'churned', 'lost', 'spam'],
};

const ContactSubmissionSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true, maxlength: 200 },
  companyName:  { type: String, required: true, trim: true, maxlength: 200 },
  email:        { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
  // Required for every lead type — both the merch and JP Webworks controllers
  // enforce it, so the model requires it too.
  phone:        { type: String, required: true, trim: true, maxlength: 40 },
  quantity:     { type: String, trim: true, maxlength: 80 },
  inHandDate:   { type: String, trim: true, maxlength: 40 },
  notes:        { type: String, trim: true, maxlength: 5000 },
  shipToState:  { type: String, trim: true, maxlength: 100, default: '' },
  seenByAdmin:  { type: Boolean, default: false, index: true },

  // Which business the lead is for: 'contact' = Joint Printing merch inquiry
  // (the default), 'webworks' = a JP Webworks website lead, 'atom' = a JP Atom
  // studio lead (from /atom/contact). Lets the Studio Inquiries inbox badge +
  // route them without a second collection.
  source:       { type: String, enum: ['contact', 'webworks', 'atom'], default: 'contact', index: true },
  // JP Webworks-only lead details (empty for merch inquiries).
  webworks: {
    businessType:   { type: String, trim: true, maxlength: 160, default: '' },
    currentWebsite: { type: String, trim: true, maxlength: 300, default: '' },
    planInterest:   { type: String, trim: true, maxlength: 40,  default: '' },
    serviceArea:    { type: String, trim: true, maxlength: 160, default: '' },
  },
  // JP Atom-only lead details (empty otherwise). The /atom/contact form already
  // asks these — structured here (like `webworks` above) so the inbox can show
  // fields instead of a notes blob. `notes` still carries the flattened copy for
  // the email + any surface that only reads notes.
  atom: {
    runsOn:        { type: String, trim: true, maxlength: 300, default: '' },  // what they run the shop on today
    monthlyVolume: { type: String, trim: true, maxlength: 40,  default: '' },  // orders per month
    interests:     { type: String, trim: true, maxlength: 300, default: '' },  // what it should handle first
  },

  selectedProducts: [{
    style:     String,
    name:      String,
    vendor:    String,
    tag:       String,
    thumbnail: String,
  }],

  attachments: [{
    filename:    String,
    contentType: String,
    sizeBytes:   Number,
  }],

  // Spam/abuse signals
  ipAddress:    String,
  userAgent:    String,
  honeypot:     { type: Boolean, default: false },

  // Email pipeline status
  emailStatus:  { type: String, enum: ['queued', 'sent', 'failed'], default: 'queued' },
  emailError:   String,

  // ── NEW: CRM fields ──
  status:       { type: String, enum: STATUSES, default: 'new', index: true },
  notesAdmin:   { type: String, trim: true, maxlength: 10000, default: '' },
  orderId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },

  createdAt:    { type: Date, default: Date.now, index: true },
  updatedAt:    { type: Date, default: Date.now },
});

ContactSubmissionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('ContactSubmission', ContactSubmissionSchema);
module.exports.STATUSES = STATUSES;
module.exports.STATUSES_BY_SOURCE = STATUSES_BY_SOURCE;
