const mongoose = require('mongoose');

// One product from the cannabis-promotions vendor catalogs — the data behind
// the Quoter's promo picker. Each product carries BOTH sides of the money:
//   clientPriceBreaks — the vendor's client-facing price list (margin already
//                       baked in; what the owner shows the client), and
//   netCostBreaks     — what the vendor actually charges the owner.
// So a promo quote line can auto-fill the client price AND the true COGS in
// one pick, and the margin guardrail stays honest.
//
// `variant` disambiguates the vendor's shared-SKU domestic vs overseas lines
// (mylar/exit bags: same SKU, different price + lead time). '' = the default
// (domestic) line; 'overseas' = the cheaper/slower one.
//
// Data flows in via the seed file (data/promoCatalog.json, upserted on boot —
// the owner hands over a new PDF, the scrape lands there) or POST /import.
// House rule: nothing hard-deletes — retired products archive.

const ClientBreakSchema = new mongoose.Schema({
  qty:   { type: Number, required: true },
  price: { type: Number, required: true },   // per unit, dollars — client pays
}, { _id: false });

const NetBreakSchema = new mongoose.Schema({
  qty:  { type: Number, required: true },
  cost: { type: Number, required: true },    // per unit, dollars — owner pays
}, { _id: false });

const PromoProductSchema = new mongoose.Schema({
  name:        { type: String, required: true },
  sku:         { type: String, default: '', index: true },
  variant:     { type: String, default: '' },            // '' | 'overseas'
  category:    { type: String, default: '', index: true },
  description: { type: String, default: '' },

  moq:        { type: Number, default: null },   // explicit vendor minimum, when stated
  turnaround: { type: String, default: '' },     // as printed ("3-5 Business Days", "8-10 weeks")
  printMethod:{ type: String, default: '' },
  printCost:  { type: String, default: '' },     // usually "Included"; kept verbatim

  // Setup fees as printed (strings like "$50", "$40 (G)") — client-facing vs net.
  setupCostClient: { type: String, default: '' },
  setupCostNet:    { type: String, default: '' },

  clientPriceBreaks: { type: [ClientBreakSchema], default: [] },
  netCostBreaks:     { type: [NetBreakSchema], default: [] },

  flags:  { type: [String], default: [] },       // scrape caveats (shared SKU, packs, CR…)
  source: { type: String, default: '' },         // which catalog drop it came from

  archived:   { type: Boolean, default: false, index: true },
  archivedAt: { type: Date, default: null },
}, { timestamps: true });

PromoProductSchema.index({ sku: 1, variant: 1 });
PromoProductSchema.index({ archived: 1, category: 1, name: 1 });

module.exports = mongoose.model('PromoProduct', PromoProductSchema);
