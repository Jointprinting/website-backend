const mongoose = require('mongoose');

// One run of the dispensary lead finder — an audit row per sweep so the Studio
// can show "last NJ sweep: 214 found, 173 with email, 41 new" and the runner can
// tell how much of a region is already worked. Lightweight; pattern mirrors
// JpwSchedulerState/JpwApiUsage.
const LeadFinderRunSchema = new mongoose.Schema({
  region:   { type: String, default: '', index: true },
  dryRun:   { type: Boolean, default: false },
  found:    { type: Number, default: 0 },   // dispensaries discovered in OSM
  withEmail:{ type: Number, default: 0 },   // had an email (from OSM or scrape)
  enriched: { type: Number, default: 0 },   // emails obtained by website scrape
  verified: { type: Number, default: 0 },   // emails that passed the MX/deliverability check
  created:  { type: Number, default: 0 },   // new CRM leads
  updated:  { type: Number, default: 0 },   // existing CRM records touched
  skipped:  { type: Number, default: 0 },   // no email / suppressed / no company
  error:    { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('LeadFinderRun', LeadFinderRunSchema);
