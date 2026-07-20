const mongoose = require('mongoose');

// A cold-outreach email campaign: an ordered sequence of merge-templated steps
// (day-0 intro → follow-up → breakup) that enrolled CRM companies walk through.
// The campaign is the TEMPLATE; per-company progress lives in OutreachEnrollment.
// The sender engine (services/outreachEngine.js) only ever sends for campaigns
// whose status is 'active', so pausing a campaign instantly halts its queue
// without touching any enrollment state.

const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'archived'];

// One email in the sequence. `offsetDays` = days AFTER the previous step's send
// (ignored on the first step, which is due as soon as the company is enrolled —
// the engine's daily cap paces the actual sends). Subject/body support
// {{mergeField}} and {{mergeField|fallback}} tokens rendered per company — see
// buildMergeContext in services/outreachEngine.js for the available fields.
const StepSchema = new mongoose.Schema({
  offsetDays: { type: Number, default: 0 },
  subject:    { type: String, default: '' },
  body:       { type: String, default: '' },
  // By default a follow-up (step > 0) THREADS into the first email: it reuses
  // "Re: <original subject>" + In-Reply-To/References so it lands in the same
  // conversation. Set freshSubject:true on a step to deliberately break out with
  // its own new subject line instead.
  freshSubject: { type: Boolean, default: false },
  // Optional subject A/B test: when set, a stable half of enrollments get this
  // instead of `subject` on the step's send. Only applies where the subject is
  // actually used — step 0 and freshSubject steps; threaded follow-ups reuse
  // "Re: <original>" regardless. Results are read per-variant off sends[].variant.
  subjectB: { type: String, default: '' },
}, { _id: false });

const OutreachCampaignSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  status:      { type: String, enum: CAMPAIGN_STATUSES, default: 'draft', index: true },
  steps:       { type: [StepSchema], default: [] },
  // The business VERTICAL this campaign targets (services/leadVerticals.js) —
  // which kind of lead the free finder hunts for it and which tagged pool its
  // enrollment draws from. Defaults to 'dispensary' (the historical + default
  // vertical), so every existing campaign keeps behaving exactly as before.
  vertical:    { type: String, default: 'dispensary', index: true },
  // Subject A/B auto-winner: '' while the test runs (50/50 split); once one arm
  // proves decisively better (decideAbWinner in controllers/outreach.js), the
  // winning letter is locked here and every NEW send uses it — the test stops
  // burning half the volume on the losing subject. Cleared by editing the step.
  abWinner:    { type: String, enum: ['', 'A', 'B'], default: '' },
  abWinnerAt:  { type: Date, default: null },
  // When the engine's automatic roster hygiene last ran for this campaign
  // (services/outreachEngine.js runRosterHygiene): on a bounce spike, the
  // not-yet-contacted roster is re-verified against live MX and dead addresses
  // are dropped + suppressed automatically. This stamp bounds the pass to at
  // most once per campaign per 24h, and lets campaignHealth say "re-verified
  // the waiting roster" only when that actually just happened.
  lastHygieneAt: { type: Date, default: null },
  // LIST QUARANTINE — the engine acting on its own "this list source is bad"
  // verdict instead of printing advice: when a campaign keeps bouncing hard
  // even AFTER roster hygiene ran (see shouldQuarantineList in
  // services/outreachEngine.js), NEW first-touches stop automatically — the
  // daily budget stops burning on a rotten pool. Follow-ups to leads that
  // already received mail (proven-deliverable) continue, and auto-enroll skips
  // a quarantined campaign so the reserve isn't poured into it. Cleared from
  // the campaign editor ("resume first touches") once the list is rebuilt.
  firstTouchQuarantinedAt: { type: Date, default: null },
  quarantineReason:        { type: String, default: '' },
}, { timestamps: true });

OutreachCampaignSchema.statics.CAMPAIGN_STATUSES = CAMPAIGN_STATUSES;

const OutreachCampaign = mongoose.model('OutreachCampaign', OutreachCampaignSchema);
OutreachCampaign.CAMPAIGN_STATUSES = CAMPAIGN_STATUSES;

module.exports = OutreachCampaign;
