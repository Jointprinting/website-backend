const mongoose = require('mongoose');

// One company's walk through one campaign's sequence. Linked to the CRM by the
// same companyKey the rest of the system uses (never a copy of the company —
// the Client record stays the single source of truth; this only tracks
// sequence position + engagement). One enrollment per (campaign, company),
// enforced by the compound unique index below.
//
// Status lifecycle (terminal states never resume sending):
//   active       → in the sequence; the engine sends its next due step
//   replied      → they answered — sequence stops, lead goes warm (Today queue)
//   completed    → every step sent, no reply (candidate for a future campaign)
//   unsubscribed → they opted out — Client.doNotEmail is set alongside
//   stopped      → owner/engine halted it (see stopReason)
//   failed       → 3 consecutive SMTP errors on one step
const ENROLLMENT_STATUSES = ['active', 'replied', 'completed', 'unsubscribed', 'stopped', 'failed'];

// One actual send — audit trail + open tracking. openedAt is stamped by the
// public pixel route the first time that send's pixel loads.
const SendSchema = new mongoose.Schema({
  stepIndex: { type: Number, default: 0 },
  at:        { type: Date, default: Date.now },
  subject:   { type: String, default: '' },
  messageId: { type: String, default: '' },
  openedAt:  { type: Date, default: null },
}, { _id: false });

const OutreachEnrollmentSchema = new mongoose.Schema({
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'OutreachCampaign', required: true, index: true },
  companyKey: { type: String, required: true, index: true },
  // Denormalized for queue/funnel rows without a per-row Client lookup. The
  // engine re-reads the live Client at send time, so an owner edit (fixed
  // email, archived, do-not-email) always wins over these snapshots.
  companyName: { type: String, default: '' },
  toEmail:     { type: String, default: '' },

  status:    { type: String, enum: ENROLLMENT_STATUSES, default: 'active', index: true },
  stepIndex: { type: Number, default: 0 },              // next step to send
  nextSendAt: { type: Date, default: null, index: true }, // when that step is due

  sends:        { type: [SendSchema], default: [] },
  // The first send's Message-ID + rendered subject — so follow-up touches thread
  // into the SAME conversation (In-Reply-To/References + "Re: <subject>") instead
  // of landing as disconnected cold emails, which reads human and lifts delivery.
  originMessageId: { type: String, default: '' },
  originSubject:   { type: String, default: '' },
  openCount:    { type: Number, default: 0 },
  lastOpenedAt: { type: Date, default: null },
  repliedAt:    { type: Date, default: null },
  unsubscribedAt: { type: Date, default: null },
  stopReason:   { type: String, default: '' },          // 'no-email', 'became-customer', 'owner', ...

  // Per-step SMTP retry bookkeeping — reset on every successful send.
  sendAttempts: { type: Number, default: 0 },
  lastError:    { type: String, default: '' },

  // Unguessable handle for the PUBLIC unsubscribe + open-pixel routes, so those
  // URLs can't be enumerated to flip other people's enrollments.
  token: { type: String, required: true, unique: true, index: true },
}, { timestamps: true });

// One enrollment per company per campaign — re-enrolling is an update, never a
// duplicate row.
OutreachEnrollmentSchema.index({ campaignId: 1, companyKey: 1 }, { unique: true });
// The engine's due-scan: active enrollments ordered by when they're due.
OutreachEnrollmentSchema.index({ status: 1, nextSendAt: 1 });

OutreachEnrollmentSchema.statics.ENROLLMENT_STATUSES = ENROLLMENT_STATUSES;

const OutreachEnrollment = mongoose.model('OutreachEnrollment', OutreachEnrollmentSchema);
OutreachEnrollment.ENROLLMENT_STATUSES = ENROLLMENT_STATUSES;

module.exports = OutreachEnrollment;
