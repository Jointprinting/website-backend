// models/Suppression.js
//
// Global, ADDRESS-LEVEL do-not-contact list for cold outreach — the compliance
// backbone. Distinct from Client.doNotEmail (which is per-company and only
// exists once a Client record does): this suppresses a raw email address
// EVERYWHERE, forever, even when we have no Client for it — an unmatched
// unsubscribe, a bounced address on a lead we never imported, a hard bounce
// reported by the provider. It's checked at BOTH enroll time and send time, so
// a suppressed address can never re-enter the machine no matter how a lead is
// (re-)discovered. Written on every unsubscribe, spam complaint, and permanent
// (hard) bounce. Never cleared automatically.

const mongoose = require('mongoose');

const SuppressionSchema = new mongoose.Schema({
  // The address, always normalized lower-case. Unique so re-suppressing is a
  // cheap idempotent upsert.
  email:  { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  // The domain (indexed) so a future "suppress a whole burned domain" tool and
  // domain-level analytics are cheap.
  domain: { type: String, default: '', index: true },
  // Why it's suppressed: 'unsubscribe' | 'complaint' | 'hard-bounce' |
  // 'do-not-contact' | 'manual'. Kept for audit + the deliverability report.
  reason: { type: String, default: '' },
  // Where the signal came from: 'unsubscribe-link' | 'bounce-webhook' |
  // 'smtp-bounce' | 'triage' | 'manual'.
  source: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('Suppression', SuppressionSchema);
