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
  phone:        { type: String, required: true, trim: true, maxlength: 40 },
  quantity:     { type: String, trim: true, maxlength: 80 },
  inHandDate:   { type: String, trim: true, maxlength: 40 },
  notes:        { type: String, trim: true, maxlength: 5000 },
  shipToState:  { type: String, trim: true, maxlength: 100, default: '' },
  seenByAdmin:  { type: Boolean, default: false, index: true },

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

  createdAt:    { type: Date, default: Date.now, index: true },
  updatedAt:    { type: Date, default: Date.now },
});

ContactSubmissionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('ContactSubmission', ContactSubmissionSchema);
module.exports.STATUSES = STATUSES;
