// models/PromoCatalogItem.js
//
// A single promotional product the owner sells (lighters, grinders, ashtrays,
// etc.) with a fixed, already-marked-up price — the vendor promo quotes come
// pre-margined, so these sell at 0% markup in the Quoter (`noMarkup`). Items are
// hand-added or, more often, auto-scanned out of a vendor promo-quote PDF
// (services/promoQuoteScanner.js) and confirmed by the owner before they go live.
//
// Kept separate from `Product` (apparel blanks synced from S&S/AlphaBroder, unique
// `style`, "starting at" pricing) because a promo item has a fixed sell price, a
// different lifecycle, and provenance (which PDF it came from) — the same reason
// Receipt is its own model.

const mongoose = require('mongoose');

// One quantity → price tier (promo pricing is usually quantity-broken).
const priceBreakSchema = new mongoose.Schema({
  qty:   { type: Number, default: 0 },   // quantity threshold
  price: { type: Number, default: 0 },   // client price per unit at/above this qty
  cost:  { type: Number, default: 0 },   // owner cost per unit at this qty (optional)
}, { _id: false });

const promoCatalogItemSchema = new mongoose.Schema({
  vendor:      { type: String, default: '' },       // supplier the quote came from
  name:        { type: String, required: true },    // product name
  sku:         { type: String, default: '' },       // vendor item / style number
  description: { type: String, default: '' },       // size / material / imprint detail
  category:    { type: String, default: 'Promo' },  // Grinder, Lighter, Ashtray, …
  color:       { type: String, default: '' },
  // price = the client-facing per-unit price (vendor catalogs already include the
  // owner's margin, so this is what a Quoter line uses as a fixed unitPrice).
  // cost = the owner's cost per unit, for the COGS estimate — optional; 0 when the
  // quote doesn't break it out (the owner can fill it in review).
  price:       { type: Number, default: 0 },
  cost:        { type: Number, default: 0 },
  minQty:      { type: Number, default: 0 },
  unit:        { type: String, default: 'each' },
  priceBreaks: { type: [priceBreakSchema], default: [] },
  notes:       { type: String, default: '' },
  active:      { type: Boolean, default: true },    // false = hidden from the Quoter picker

  // ── provenance: where a scanned item came from, so a price is auditable ──
  sourcePdfUrl:   { type: String, default: '' },    // R2 URL of the original quote
  sourceFileName: { type: String, default: '' },
  confidence:     { type: String, default: '' },    // AI read confidence (high/medium/low)
}, { timestamps: true });

promoCatalogItemSchema.index({ active: 1, category: 1, name: 1 });

module.exports = mongoose.model('PromoCatalogItem', promoCatalogItemSchema);
