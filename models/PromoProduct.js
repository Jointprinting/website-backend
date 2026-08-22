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

  // ── Shipping weight ────────────────────────────────────────────────────────
  // The vendor catalogs carry price breaks but NO weights, so promo freight had
  // to be guessed. `unitWeightOz` is the weight of ONE PRICED UNIT (a cone
  // 3-pack counts as one), and `weightSource` records how much to trust it:
  //   'owner'     — the owner measured/entered it. Highest authority.
  //   'catalog'   — the vendor published it. Same authority as owner.
  //   'estimated' — derived by services/promoWeights.js from the description's
  //                 dimensions and material.
  // services/promoWeights.js#effectiveUnitWeightOz honors that precedence, and
  // the boot-time seed never overwrites an owner/catalog weight — see
  // controllers/promoProducts.js#upsertOne.
  unitWeightOz: { type: Number, default: null },
  weightSource: { type: String, default: '', enum: ['', 'owner', 'catalog', 'estimated'] },
  // Units the vendor packs per carton, when they tell us. Sharpens cartonization
  // in services/promoShipping.js; null = fall back to the weight/volume ceiling.
  cartonPackQty: { type: Number, default: null },

  // ── Who sells it ───────────────────────────────────────────────────────────
  // This was never a field. The catalog IS one vendor's catalog, and that vendor
  // was hardcoded in three places: the picker's title ("every item here POs to
  // Cannabis Promotions"), the freight ORIGIN as a module constant in
  // services/promoShipping.js, and services/promoWeights.js.
  //
  // Which is why the owner cannot record a rug supplier he found on
  // DistributorCentral: there is nowhere to put one.
  //
  // The DEFAULT is the backfill. Every one of the existing products is Cannabis
  // Promotions, so they are all correct the moment this field exists — no
  // migration, no script, nothing to run. A second supplier is then a second
  // vendorKey rather than a fork of the catalog.
  //
  // Matches Vendor.vendorKey, so a promo product joins the same vendor spine as
  // POs, spend and terms.
  vendorKey: { type: String, default: 'cannabis promotions', index: true },
  // Where this vendor ships FROM, when it differs from the default origin.
  // Freight is a leg from a real place; a rug supplier in North Carolina is not
  // a 2.5-hour drive from St. Petersburg. Blank = use the vendor's own address,
  // then the module default.
  shipsFromZip: { type: String, default: '' },

  archived:   { type: Boolean, default: false, index: true },
  archivedAt: { type: Date, default: null },
}, { timestamps: true });

PromoProductSchema.index({ sku: 1, variant: 1 });
PromoProductSchema.index({ archived: 1, category: 1, name: 1 });
// Browsing one supplier's catalog, and rolling up spend per supplier.
PromoProductSchema.index({ vendorKey: 1, archived: 1 });

module.exports = mongoose.model('PromoProduct', PromoProductSchema);
