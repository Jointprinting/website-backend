// models/TriageReply.js
//
// One detected/imported buyer reply in the Gmail Reply Triage inbox. This is a
// lightweight triage record — NOT a CRM record. The Client (companyKey) stays the
// single source of truth; a matched reply just links back to it. Ownership fields
// (ownerId/agentId) are intentionally absent — this is the single-admin Studio.

const mongoose = require('mongoose');
const { CATEGORIES, STATUSES } = require('../services/replyTriage');

const TriageReplySchema = new mongoose.Schema({
  // The reply as pasted/imported (or, in a future V2, synced from Gmail).
  fromEmail:  { type: String, default: '', index: true },
  fromName:   { type: String, default: '' },
  subject:    { type: String, default: '' },
  snippet:    { type: String, default: '' },       // short preview only, not the full body
  receivedAt: { type: Date, default: Date.now, index: true },

  // Classification + the owner's triage state.
  category:        { type: String, enum: CATEGORIES, default: 'needs_response', index: true },
  suggestedAction: { type: String, default: '' },
  status:          { type: String, enum: STATUSES, default: 'new', index: true },

  // Link to an existing outreach lead. companyKey is the join key used everywhere;
  // an unmatched reply keeps these blank (still shown, never hidden).
  matched:      { type: Boolean, default: false, index: true },
  // HOW it matched: 'thread' | 'email' | 'subject' | 'domain' | 'none'. Thread/
  // email/subject are strong (safe to auto-stop + warm on); 'domain' is a soft
  // same-business-domain link the UI shows but the loop never auto-acts on.
  matchBy:      { type: String, default: '' },
  companyKey:   { type: String, default: '' },
  companyName:  { type: String, default: '' },
  enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'OutreachEnrollment', default: null },

  source: { type: String, enum: ['manual', 'import', 'gmail'], default: 'manual' },

  // Set only for Gmail-synced rows so a re-sync can dedupe. Manual/import rows
  // leave it null; the partial unique index below ignores nulls.
  gmailMessageId: { type: String, default: null },

  handledAt: { type: Date, default: null },
}, { timestamps: true });

// Newest-first listing.
TriageReplySchema.index({ receivedAt: -1 });
// Dedupe synced messages without blocking the many null manual/import rows.
TriageReplySchema.index(
  { gmailMessageId: 1 },
  { unique: true, partialFilterExpression: { gmailMessageId: { $type: 'string' } } },
);

module.exports = mongoose.model('TriageReply', TriageReplySchema);
