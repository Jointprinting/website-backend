const mongoose = require('mongoose');

// A printer's pricing matrix, modeled generically so wildly different printers
// (screen print by the dozen × ink colors, embroidery by stitch count, DTG by
// imprint size, wide-format media by sheet size…) all fit ONE shape. A rate
// card is a set of named pricing GRIDS plus fees/rules. The quoter does a
// deterministic lookup against it — no AI prices a live quote.
//
// Grid = rows (quantity breaks) × columns (a tier axis) → per-unit cost.
// Everything is editable from the admin rate-card UI so Nate can correct or
// extend a printer without code.

// One column tier the lookup matches an input against. Numeric axes (ink
// colors, stitch counts) use min/max ranges; keyed axes (imprint size, sides)
// match `key` exactly.
const ColumnSchema = new mongoose.Schema({
  key:   { type: String, default: '' },
  label: { type: String, default: '' },
  min:   { type: Number, default: null },   // inclusive; null = open
  max:   { type: Number, default: null },   // inclusive; null = open
  _id: false,
});

const FeeSchema = new mongoose.Schema({
  kind:      { type: String, default: 'flat' },  // per_screen | per_color | flat | digitizing
  label:     { type: String, default: '' },
  amount:    { type: Number, default: 0 },
  estimate:  { type: Boolean, default: false },  // true = a placeholder Nate should confirm
  waiveOverQty: { type: Number, default: 0 },    // fee is waived when quantity exceeds this (0 = never)
  _id: false,
});

// Conditional surcharge. isPercent multiplies the print price; perQuote means it
// can't be auto-priced and the lookup just flags it.
const AddOnSchema = new mongoose.Schema({
  key:       { type: String, default: '' },
  label:     { type: String, default: '' },
  amount:    { type: Number, default: 0 },
  isPercent: { type: Boolean, default: false },
  per:       { type: String, default: 'unit' },   // unit | order | color | location
  perQuote:  { type: Boolean, default: false },
  _id: false,
});

const GroupSchema = new mongoose.Schema({
  id:     { type: String, default: '' },
  method: { type: String, default: '' },          // screen_print | embroidery | dtg | dtf | media | personalization
  label:  { type: String, default: '' },
  // Disambiguates multiple grids for one method (e.g. light vs dark garment,
  // white/black/color DTG, sticker vs magnet). Empty = the method's only grid.
  selectorDim:   { type: String, default: '' },   // garment_shade | product | sides | ...
  selectorValue: { type: String, default: '' },
  quantityUnit:  { type: String, default: 'pieces' }, // pieces | dozens
  columnAxis:    { type: String, default: 'none' },   // ink_colors | stitch_band | imprint_size | sides | none
  qtyBreaks:     { type: [Number], default: [] },     // ascending; lookup snaps DOWN to a break
  columns:       { type: [ColumnSchema], default: [] },
  grid:          { type: mongoose.Schema.Types.Mixed, default: [] }, // qtyBreaks × columns of Number|null (null = N/A)
  perLocation:   { type: Boolean, default: false },   // multiply unit price (and per-screen fees) by # locations
  areaPriced:    { type: Boolean, default: false },   // grid is a $/sq-in rate; multiply by design area (DTF)
  fees:          { type: [FeeSchema], default: [] },
  rules:         { type: [String], default: [] },     // e.g. dark_underbase_add_color
  addOns:        { type: [AddOnSchema], default: [] },
  minOrder:      { type: Number, default: 0 },        // order floor (e.g. $20 min)
  notes:         { type: String, default: '' },
  _id: false,
});

const PrinterRateCardSchema = new mongoose.Schema({
  printerName:   { type: String, index: true },   // matches Vendor.name / order.printerName
  region:        { type: String, default: '' },   // East | Mid | West
  state:         { type: String, default: '' },   // for nexus / proximity-to-client picking
  sourceFile:    { type: String, default: '' },   // provenance (the Drive PDF)
  effectiveDate: { type: String, default: '' },
  groups:        { type: [GroupSchema], default: [] },
  notes:         { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('PrinterRateCard', PrinterRateCardSchema);
