// models/ContactSubmission.js
//
// We persist every contact submission to Mongo, then send the email.
// That way you never lose a lead because SMTP hiccupped.

const mongoose = require('mongoose');

const ContactSubmissionSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true, maxlength: 200 },
  companyName:  { type: String, required: true, trim: true, maxlength: 200 },
  email:        { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
  phone:        { type: String, required: true, trim: true, maxlength: 40 },
  quantity:     { type: String, trim: true, maxlength: 80 },
  inHandDate:   { type: String, trim: true, maxlength: 40 },
  notes:        { type: String, trim: true, maxlength: 5000 },

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
  honeypot:     { type: Boolean, default: false }, // true if a hidden field was filled

  // Email pipeline status
  emailStatus:  { type: String, enum: ['queued', 'sent', 'failed'], default: 'queued' },
  emailError:   String,

  createdAt:    { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model('ContactSubmission', ContactSubmissionSchema);
