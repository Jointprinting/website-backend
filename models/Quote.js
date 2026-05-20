const mongoose = require('mongoose');

const RowSchema = new mongoose.Schema({
  styleCode:        { type: String, default: '' },
  brand:            { type: String, default: '' },
  productType:      { type: String, default: '' },
  tier:             { type: String, enum: ['budget', 'mid', 'premium'], default: 'mid' },
  quantity:         { type: Number, default: 48 },
  blankPrice:       { type: Number, default: 0 },
  printType:        { type: String, default: 'Screen Printing' },
  printColors:      { type: Number, default: 1 },
  locations:        { type: Number, default: 1 },
  printCostPerUnit: { type: Number, default: 0 },
  setupCost:        { type: Number, default: 0 },
  shippingCost:     { type: Number, default: 0 },
  selected:         { type: Boolean, default: false },
  selectedMargin:   { type: Number, default: 30 },
  garmentColor:     { type: String, default: '' },
  notes:            { type: String, default: '' },
}, { _id: false });

const GroupSchema = new mongoose.Schema({
  garmentType: { type: String, default: '' },
  qtyTiers:    [{ type: Number }],
  rows: [RowSchema],
}, { _id: false });

// Per-size qty map for confirmation page items
const ConfItemSchema = new mongoose.Schema({
  fromQuoter:   { type: Boolean, default: true },
  label:        { type: String, default: '' },
  brand:        { type: String, default: '' },
  styleCode:    { type: String, default: '' },
  printType:    { type: String, default: '' },
  garmentColor: { type: String, default: '' },
  unitPrice:    { type: Number, default: 0 },
  productName:  { type: String, default: '' },
  sizeBreakdown: {
    type: Map,
    of: Number,
    default: () => ({ S: 0, M: 0, L: 0, XL: 0 }),
  },
  notes: { type: String, default: '' },
}, { _id: false });

const QuoteSchema = new mongoose.Schema({
  clientName:  { type: String, default: '', index: true },
  companyName: { type: String, default: '' },
  printerName: { type: String, default: '' },
  date:        { type: Date, default: Date.now },
  notes:       { type: String, default: '' },
  garmentGroups: [GroupSchema],
  status: { type: String, enum: ['draft', 'finalized'], default: 'draft' },

  confPage: {
    orderTitle:    { type: String, default: '' },
    shippingName:  { type: String, default: '' },
    attentionName: { type: String, default: '' },
    streetAddress: { type: String, default: '' },
    cityStateZip:  { type: String, default: '' },
    items:         [ConfItemSchema],
    shippingReserve: { type: Number, default: 0 },
    paymentMethod: { type: String, enum: ['card', 'ach', 'venmo', 'other'], default: 'card' },
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

QuoteSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Quote', QuoteSchema);
