const mongoose = require('mongoose');

// Tiny singleton state doc for the outreach sender engine — pattern mirrors
// JpwSchedulerState. `firstSendAt` anchors the deliverability warm-up ramp
// (services/outreachEngine.js rampCap): the daily cap starts small the week of
// the first-ever send and climbs weekly, so a fresh sending address builds
// reputation instead of getting flagged. last_run/last_result power the
// Studio's engine-status readout.
const OutreachStateSchema = new mongoose.Schema({
  key:         { type: String, required: true, unique: true }, // always 'engine'
  firstSendAt: { type: Date, default: null },
  // PER-INBOX warm-up anchors: { <senderLabel>: Date }. Each inbox in the pool
  // ramps from ITS OWN first send — so adding a fresh inbox months in starts it
  // at 10/day like a new address should, instead of inheriting the pool's age
  // and blasting at full cap from day one (which would burn the new mailbox).
  // Keys are sanitized sender labels (dots/dollars → '_', see senderKey()).
  senderFirstSendAt: { type: Object, default: {} },
  last_run_at: { type: Date, default: null },
  last_result: { type: String, default: '' },
  // O(1) daily-sent counter (ET day). Avoids re-aggregating every enrollment's
  // unbounded sends[] on every 15-min tick just to enforce the daily cap; seeds
  // itself from the authoritative scan once per day at rollover (engine
  // getSentToday), then $inc's per send.
  sentToday:     { type: Number, default: 0 },
  sentTodayDate: { type: String, default: '' }, // "YYYY-MM-DD" in ET
  // Read-only Gmail reply-ingest bookkeeping (Wave 2) — powers the "last synced
  // Xm ago · N new" pill.
  gmailLastSyncAt: { type: Date, default: null },
  gmailLastCount:  { type: Number, default: 0 },
  // Auto-enroll (Wave 7): when set, the finder reserve is topped straight into
  // this campaign on a cron. Null = off (the owner enrolls manually).
  autoEnrollCampaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'OutreachCampaign', default: null },
}, { timestamps: true });

module.exports = mongoose.model('OutreachState', OutreachStateSchema);
