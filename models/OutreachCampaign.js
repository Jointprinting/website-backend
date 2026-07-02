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
}, { _id: false });

const OutreachCampaignSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  description: { type: String, default: '' },
  status:      { type: String, enum: CAMPAIGN_STATUSES, default: 'draft', index: true },
  steps:       { type: [StepSchema], default: [] },
}, { timestamps: true });

OutreachCampaignSchema.statics.CAMPAIGN_STATUSES = CAMPAIGN_STATUSES;

const OutreachCampaign = mongoose.model('OutreachCampaign', OutreachCampaignSchema);
OutreachCampaign.CAMPAIGN_STATUSES = CAMPAIGN_STATUSES;

module.exports = OutreachCampaign;
