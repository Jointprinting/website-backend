const mongoose = require('mongoose');

// Singleton owner-preferences doc for the finance tab. One doc, key 'settings',
// mirroring the OutreachState / LeadFinderState pattern. First use: the owner's
// CUSTOM transaction categories. The built-in list stays on the Transaction
// model because it drives P&L semantics (Client Sales = revenue, the COGS set =
// per-order margin math); these are extra expense labels he can add/remove from
// the Studio without a deploy — they roll up as operating expenses.
const FinanceSettingsSchema = new mongoose.Schema({
  key:              { type: String, required: true, unique: true }, // always 'settings'
  customCategories: { type: [String], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('FinanceSettings', FinanceSettingsSchema);
