// models/Product.js
const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema({
  name:         { type: String },
  vendor:       { type: String, default: 'Joint Printing' },
  style:        { type: String, unique: true },
  description:  { type: String },

  sizeRangeBottom: { type: String },
  sizeRangeTop:    { type: String },

  // "Starting at $X" price (single number). For S&S styles this is blank cost
  // x small markup; printing cost is communicated separately, not baked in.
  // Legacy priceRangeBottom/Top kept for AlphaBroder + admin-imported products.
  priceFrom:        { type: Number },
  priceRangeBottom: { type: Number },
  priceRangeTop:    { type: Number },

  colors:     [{ type: String }],
  colorCodes: [{ type: String }],

  // For S&S styles, these now store S&S CDN URLs directly (strings) rather
  // than GridFS ObjectIds. Free Mongo M0 only has 512 MB — storing image
  // blobs would blow the cap. Legacy ObjectId arrays from old AlphaBroder
  // syncs still work via populateImages.
  productFrontImages: [{ type: mongoose.Schema.Types.Mixed }],
  productBackImages:  [{ type: mongoose.Schema.Types.Mixed }],

  rating:   { type: Number, default: 5 },
  tag:      { type: String, default: 'New Arrival' },
  category: { type: String, default: 'T-Shirts' },
  type:     { type: String, default: 'Unisex' },

  // ── S&S Activewear integration metadata ──
  source:       { type: String, enum: ['manual', 'alphabroder', 'ssactivewear'], default: 'manual' },
  ssStyleID:    { type: Number },           // S&S internal numeric ID (authoritative)
  brandName:    { type: String },
  basePrice:    { type: Number },           // Lowest piecePrice across SKUs
  // ──────────────────────────────────────────

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

ProductSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Product', ProductSchema);
