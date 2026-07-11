const mongoose = require('mongoose');

// A Newsletter is one email blast the owner sends to their CLIENTS — a monthly
// update, a new catalog drop, a seasonal promo. Deliberately SEPARATE from cold
// outreach (that's prospects, ramped + throttled): this goes to people who
// already know Joint Printing, and it sends from a dedicated identity
// (NEWSLETTER_EMAIL_FROM, e.g. jointprintingshop.com) so a big warm blast can
// never dent the main transactional inbox's deliverability.
//
// Files (a winter catalog PDF, a line sheet) are UPLOADED to R2 and rendered as
// download BUTTONS in the email, not attached — a multi-MB attachment tanks
// deliverability and trips spam filters, while a clean link does not.
//
// Per-recipient tracking: each recipient carries an unguessable token that
// powers the open pixel; "replied" is cross-referenced from the reply-triage
// inbox at read time (no coupling), since replies land in the main inbox.

const RecipientSchema = new mongoose.Schema({
  companyKey: { type: String, default: '' },
  name:       { type: String, default: '' },
  email:      { type: String, required: true },
  token:      { type: String, required: true },   // open-pixel handle
  sentAt:     { type: Date, default: null },
  failed:     { type: Boolean, default: false },
  error:      { type: String, default: '' },
  openedAt:   { type: Date, default: null },
  openCount:  { type: Number, default: 0 },
}, { _id: false });

const AttachmentSchema = new mongoose.Schema({
  filename: { type: String, default: '' },
  url:      { type: String, default: '' },   // R2 public URL
  size:     { type: Number, default: 0 },
  kind:     { type: String, default: '' },   // 'pdf' | 'image' | 'file'
}, { _id: false });

const NewsletterSchema = new mongoose.Schema({
  subject:   { type: String, default: '' },
  preheader: { type: String, default: '' },   // the gray preview line after the subject
  // The body as the owner types it (plain text w/ blank-line paragraphs); the
  // controller wraps it into the branded HTML shell at send time.
  body:      { type: String, default: '' },
  heroImage: { type: String, default: '' },   // optional banner image (R2 URL)
  files:     { type: [AttachmentSchema], default: [] },

  // Who it goes to. 'all' = every emailable client; 'customers' = stage
  // customer/won; 'tag' = a specific CRM tag (audienceTag). doNotEmail is always
  // excluded, whatever the audience.
  audience:    { type: String, enum: ['all', 'customers', 'leads', 'tag'], default: 'all' },
  audienceTag: { type: String, default: '' },

  status:  { type: String, enum: ['draft', 'sending', 'sent', 'failed'], default: 'draft', index: true },
  sentAt:  { type: Date, default: null },
  recipients: { type: [RecipientSchema], default: [] },

  // Soft-archive (house rule); archived newsletters purge after the TTL like
  // lookbooks/content — a sent blast is a presentation artifact, not a ledger.
  archived:   { type: Boolean, default: false, index: true },
  archivedAt: { type: Date, default: null },
}, { timestamps: true });

NewsletterSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model('Newsletter', NewsletterSchema);
