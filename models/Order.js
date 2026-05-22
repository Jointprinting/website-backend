const mongoose = require('mongoose');

function deriveCompanyKey(companyName, clientName) {
  const raw = (companyName || clientName || '').toString();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const OrderSchema = new mongoose.Schema({
  projectNumber: { type: String, index: true },
  orderNumber:   { type: String, index: true },
  clientName:    { type: String, default: '', index: true },
  companyName:   { type: String, default: '', index: true },
  companyKey:    { type: String, default: '', index: true },
  status: {
    type: String,
    enum: ['quoted', 'approved', 'placed', 'in_production', 'shipped', 'delivered', 'cancelled'],
    default: 'quoted',
  },
  paid:          { type: Boolean, default: false },
  totalValue:    { type: Number, default: 0 },
  cogs:          { type: Number, default: 0 },
  printerName:   { type: String, default: '' },
  supplier:      { type: String, default: '' },
  notes:         { type: String, default: '' },
  confirmationMessage: { type: String, default: '' },  // personal note on the client-facing confirmation
  confirmationTerms:   { type: String, default: '' },  // payment / turnaround terms
  approvalToken:       { type: String, default: '' },  // random token used to gate public approval page
  approvalEvents: [{                                    // log of client interactions on the approval page
    kind:    { type: String },          // 'viewed' | 'approved' | 'requested_changes'
    message: { type: String, default: '' },
    at:      { type: Date, default: Date.now },
    _id: false,
  }],
  // General-purpose activity log. New event kinds (status changes, paid
  // toggles, files uploaded, etc.) land here as they get tracked. Render
  // in the drawer as a merged timeline with approvalEvents.
  activity: [{
    kind:    { type: String },          // 'created' | 'status_changed' | 'paid_changed' | 'duplicated_from' | 'file_uploaded' | 'mockups_linked'
    actor:   { type: String, default: 'admin' },        // 'admin' | 'client' | 'system'
    message: { type: String, default: '' },
    meta:    { type: mongoose.Schema.Types.Mixed, default: {} },
    at:      { type: Date,   default: Date.now },
    _id: false,
  }],

  // Final confirmation page — the operational doc sent to the client AFTER
  // they approve and pick a subset of the quote. Structure mirrors the user's
  // existing Excel template: header info, shipping, items with size breakdowns
  // and per-item mockup snapshot, plus custom add-on lines (shipping reserve,
  // CC fee, discounts, taxes).
  confirmation: {
    orderTitle:  { type: String, default: '' },
    orderDate:   { type: Date,   default: null },
    shipping: {
      name:         { type: String, default: '' },
      attention:    { type: String, default: '' },
      streetAddress:{ type: String, default: '' },
      cityStateZip: { type: String, default: '' },
    },
    items: [{
      mockupNum:           { type: String, default: '' },   // ref into project's saved mockups
      customMockupDataUrl: { type: String, default: '' },   // optional override (base64)
      showBack:            { type: Boolean, default: false },
      brandName:           { type: String, default: '' },
      styleCode:           { type: String, default: '' },
      printType:           { type: String, default: '' },
      color:               { type: String, default: '' },
      sizes: [{
        label:     { type: String, default: '' },  // 'XS', 'S', ..., 'OS', or any custom
        qty:       { type: Number, default: 0 },
        unitPrice: { type: Number, default: 0 },
        _id: false,
      }],
      _id: false,
    }],
    // Add-on lines applied to the subtotal of all item sizes. Order matters
    // (discounts before tax, CC fee last, etc.). Each line is either a flat
    // amount or a percent of the running subtotal-so-far.
    customLines: [{
      label:     { type: String, default: '' },
      amount:    { type: Number, default: 0 },
      isPercent: { type: Boolean, default: false },
      _id: false,
    }],
  },
  mockupNumbers: [{ type: String }],
  contactSubmissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ContactSubmission', default: null },
  items: [{
    description: { type: String, default: '' },
    qty:         { type: Number, default: 0 },
    unitPrice:   { type: Number, default: 0 },
    _id: false,
  }],
  quoteLines: [{
    qty:          { type: Number, default: 0 },
    styleCode:    { type: String, default: '' },
    description:  { type: String, default: '' },
    color:        { type: String, default: '' },
    supplier:     { type: String, default: '' },
    blankCost:    { type: Number, default: 0 },   // per unit
    printType:    { type: String, default: '' },  // e.g. "Screen Print", "DTG", "Embroidery"
    printDetails: { type: String, default: '' },  // e.g. "1 color front + 2 color back"
    printCost:    { type: Number, default: 0 },   // per unit
    markup:       { type: Number, default: 2 },   // multiplier; unit price = (blankCost + printCost) * markup
    unitPrice:    { type: Number, default: 0 },   // computed but stored so user can override
    _id: false,
  }],
  orderDate:     { type: Date },
  shipDate:      { type: Date },
  deliveredDate: { type: Date },
  importedFrom:  { type: String, default: '' },
  files: [{
    filename:     { type: String },
    originalName: { type: String },
    mimetype:     { type: String },
    size:         { type: Number },
    uploadedAt:   { type: Date, default: Date.now },
    _id: false,
  }],
}, { timestamps: true });

OrderSchema.pre('save', function (next) {
  this.companyKey = deriveCompanyKey(this.companyName, this.clientName);
  // If a structured quote exists, derive the headline total from it so the
  // card / dashboard / confirmation all agree.
  if (Array.isArray(this.quoteLines) && this.quoteLines.length > 0) {
    this.totalValue = this.quoteLines.reduce((s, l) => {
      const unit = Number(l.unitPrice) || ((Number(l.blankCost) || 0) + (Number(l.printCost) || 0)) * (Number(l.markup) || 1);
      return s + (Number(l.qty) || 0) * unit;
    }, 0);
  }
  next();
});

OrderSchema.pre('findOneAndUpdate', function (next) {
  const u = this.getUpdate() || {};
  const set = u.$set || u;
  if (set.companyName !== undefined || set.clientName !== undefined) {
    set.companyKey = deriveCompanyKey(set.companyName, set.clientName);
  }
  if (Array.isArray(set.quoteLines) && set.quoteLines.length > 0) {
    set.totalValue = set.quoteLines.reduce((s, l) => {
      const unit = Number(l.unitPrice) || ((Number(l.blankCost) || 0) + (Number(l.printCost) || 0)) * (Number(l.markup) || 1);
      return s + (Number(l.qty) || 0) * unit;
    }, 0);
  }
  if (u.$set) u.$set = set; else Object.assign(u, set);
  this.setUpdate(u);
  next();
});

module.exports = mongoose.model('Order', OrderSchema);
module.exports.deriveCompanyKey = deriveCompanyKey;
