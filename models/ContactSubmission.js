// models/ContactSubmission.js
//
// We persist every contact submission to Mongo, then send the email.
// That way you never lose a lead because SMTP hiccupped.
//
// Adds CRM-style fields: `status` (lifecycle of a lead) and `notesAdmin`
// (internal notes only visible in the studio).

const mongoose = require('mongoose');

const STATUSES = ['new', 'contacted', 'quoted', 'won', 'lost', 'spam'];

const ContactSubmissionSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true, maxlength: 200 },
  companyName:  { type: String, required: true, trim: true, maxlength: 200 },
  email:        { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
  // Phone is required for print quotes (enforced in the controller) but optional
  // for JP Webworks web-design leads, so the model itself no longer requires it.
  phone:        { type: String, trim: true, maxlength: 40, default: '' },
  quantity:     { type: String, trim: true, maxlength: 80 },
  inHandDate:   { type: String, trim: true, maxlength: 40 },
  notes:        { type: String, trim: true, maxlength: 5000 },
  shipToState:  { type: String, trim: true, maxlength: 100, default: '' },
  seenByAdmin:  { type: Boolean, default: false, index: true },

  // Which business the lead is for: 'contact' = Joint Printing merch inquiry
  // (the default), 'webworks' = a JP Webworks website lead. Lets the Studio
  // Inquiries inbox badge + route the two without a second collection.
  source:       { type: String, enum: ['contact', 'webworks'], default: 'contact', index: true },
  // JP Webworks-only lead details (empty for merch inquiries).
  webworks: {
    businessType:   { type: String, trim: true, maxlength: 160, default: '' },
    currentWebsite: { type: String, trim: true, maxlength: 300, default: '' },
    planInterest:   { type: String, trim: true, maxlength: 40,  default: '' },
    serviceArea:    { type: String, trim: true, maxlength: 160, default: '' },
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
