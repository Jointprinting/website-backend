// models/Product.js
const mongoose = require('mongoose');

const ProductSchema = new mongoose.Schema({
  name:         { type: String },
  vendor:       { type: String, default: 'Joint Printing' },
  style:        { type: String, unique: true },
  description:  { type: String },

  sizeRangeBottom: { type: String, default: 'S' },
  sizeRangeTop:    { type: String, default: 'XL' },
  // Defaults bumped to match the new T-Shirt floor (which factors in printing
  // markup). Real per-style values overwrite on sync.
  priceRangeBottom:{ type: Number, default: 13 },
  priceRangeTop:   { type: Number, default: 18 },

  colors:     [{ type: String }],
  colorCodes: [{ type: String }],

  productFrontImages: [mongoose.Schema.Types.ObjectId], // GridFS image IDs
  productBackImages:  [mongoose.Schema.Types.ObjectId],

  rating:   { type: Number, default: 5 },
  tag:      { type: String, default: 'New Arrival' },
  category: { type: String, default: 'Shirts' },
  type:     { type: String, default: 'Unisex' },

  // ── New: S&S Activewear integration metadata ──
  source:       { type: String, enum: ['manual', 'alphabroder', 'ssactivewear'], default: 'manual' },
  ssStyleID:    { type: Number },           // S&S internal styleID
  brandName:    { type: String },           // S&S brandName (Gildan, Bella+Canvas, etc.)
  basePrice:    { type: Number },           // Lowest piecePrice we found from S&S
  // ───────────────────────────────────────────────

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

ProductSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Product', ProductSchema);
