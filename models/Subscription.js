const mongoose = require('mongoose');
const { SUBSCRIPTION_BRAND_KEYS } = require('../utils/brands');

// A recurring revenue agreement — the spine of the Webworks/Atom money layer.
// Joint Printing bills per order; the two service brands (JP Webworks, JP Atom)
// bill on a recurring plan, and THIS is where that recurring relationship lives so
// the Finances view can compute MRR/ARR and split a brand P&L.
//
// Keyed by `companyKey` (the ecosystem spine — same key Orders/Deals/Client use),
// so a subscription lines up with the rest of a company's record. Optionally links
// to the built site (`siteId` → JpwSite) it's the ongoing plan for.

const SUB_STATUSES = ['active', 'paused', 'canceled'];
// How often the plan bills. MRR math normalizes annual → monthly.
const CADENCES = ['monthly', 'annual'];

const SubscriptionSchema = new mongoose.Schema({
  // ── Who it's for (ecosystem spine) ──
  companyKey:  { type: String, required: true, index: true },
  companyName: { type: String, default: '' },
  // Which brand sells this plan. Only the recurring brands (webworks, atom) —
  // mirrors the inquiry-source keys so a subscription's brand lines up with the
  // company's leads/orders. Indexed for the per-brand MRR rollup.
  brand:       { type: String, enum: SUBSCRIPTION_BRAND_KEYS, required: true, index: true },

  // ── The plan ──
  plan:    { type: String, default: '' },      // human label, e.g. "Care Plan", "Atom Standard"
  amount:  { type: Number, default: 0 },       // price PER cadence period (the raw bill, always positive)
  cadence: { type: String, enum: CADENCES, default: 'monthly' },

  // ── Lifecycle ──
  status:       { type: String, enum: SUB_STATUSES, default: 'active', index: true },
  startedAt:    { type: Date, default: Date.now },
  nextBillDate: { type: Date, default: null, index: true }, // when the next charge is due (drives "who bills soon")
  pausedAt:     { type: Date, default: null },
  canceledAt:   { type: Date, default: null },
  cancelReason: { type: String, default: '' },

  // ── Links ──
  // The site this plan keeps live (JP Webworks) — optional; an Atom system plan
  // may have none. Kept as a loose ref (no populate required) so a deleted site
  // never blocks reading the subscription.
  siteId: { type: mongoose.Schema.Types.ObjectId, ref: 'JpwSite', default: null },
  notes:  { type: String, default: '' },

  // ── Soft-delete (house rule: nothing is hard-deleted) ──
  archived:       { type: Boolean, default: false, index: true },
  archivedAt:     { type: Date, default: null },
  archivedReason: { type: String, default: '' },
}, { timestamps: true });

// The per-company card and the MRR rollup both read newest-active first.
SubscriptionSchema.index({ companyKey: 1, status: 1 });

SubscriptionSchema.statics.SUB_STATUSES = SUB_STATUSES;
SubscriptionSchema.statics.CADENCES     = CADENCES;

const Subscription = mongoose.model('Subscription', SubscriptionSchema);
Subscription.SUB_STATUSES = SUB_STATUSES;
Subscription.CADENCES     = CADENCES;

module.exports = Subscription;
