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
  // Set by the QB sync when an invoice exists with a remaining balance —
  // signals "payment initiated / pending" without overloading the binary
  // paid flag. Cleared automatically once Balance == 0.
  paymentInProgress: { type: Boolean, default: false },
  totalValue:    { type: Number, default: 0 },
  cogs:          { type: Number, default: 0 },
  printerName:   { type: String, default: '' },
  supplier:      { type: String, default: '' },
  shipToState:   { type: String, default: '' },  // quote-level destination state ("PA", "NY"); stays with the quote so re-quotes don't forget
  setupCost:     { type: Number, default: 0 },   // one-time setup fee (screens, digitizing, etc.) — flows into both COGS and client total
  shippingCost:  { type: Number, default: 0 },   // pass-through shipping
  notes:         { type: String, default: '' },
  confirmationMessage: { type: String, default: '' },  // personal note on the client-facing confirmation
  confirmationTerms:   { type: String, default: '' },  // payment / turnaround terms
  quickbooksInvoiceUrl: { type: String, default: '' }, // link to the QB invoice for this project
  tasks: [{                                            // per-project checklist
    text:        { type: String, default: '' },
    done:        { type: Boolean, default: false },
    dueDate:     { type: Date,   default: null },
    completedAt: { type: Date,   default: null },
    _id: false,
  }],
  approvalToken:          { type: String, default: '' },  // random token used to gate public approval page
  approvalTokenExpiresAt: { type: Date,   default: null }, // null = never expires; non-null = strict cutoff
  // When admin re-shares the approval link with a fresh confirmation, we
  // bump approvalSupersededAt to "now". Any approvalEvents older than this
  // timestamp are treated as historical — the client lands on a fresh
  // approval ask, not the locked "you already approved" view. Approvals
  // history is preserved (still visible in the activity drawer), but the
  // gate logic only looks at events newer than supersededAt.
  approvalSupersededAt:   { type: Date,   default: null },
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
      customMockupDataUrl: { type: String, default: '' },   // legacy single-image (kept for back-compat)
      mockupSnapshots: [{                                   // multiple variant images (e.g. headbands in 3 colors)
        dataUrl: { type: String, default: '' },
        label:   { type: String, default: '' },
        _id: false,
      }],
      showBack:            { type: Boolean, default: false },
      productName:         { type: String, default: '' },    // overrides brand+style label for non-garment items
      brandName:           { type: String, default: '' },
      styleCode:           { type: String, default: '' },
      printType:           { type: String, default: '' },
      color:               { type: String, default: '' },
      printerName:         { type: String, default: '' },    // who's actually printing this item
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
  // Client-facing order tracking timeline. Initialized the first time a
  // client approves a confirmation; admin then ticks off subsequent steps
  // from the Order Tracker tab and the client sees the same set of dates
  // on the approval link they already have. Steps are editable per-project
  // (rename, hide, add custom) since reality varies — e.g. when the blank
  // place and the printer are the same vendor those two steps collapse.
  tracking: {
    steps: [{
      id:          { type: String },              // stable key — 'confirmation_approved' etc for defaults, custom-* for added ones
      label:       { type: String, default: '' },
      completedAt: { type: Date,   default: null },
      note:        { type: String, default: '' },
      hidden:      { type: Boolean, default: false },
      // Optional URL — e.g. carrier tracking page for "Blanks shipping" or
      // "On the way to you". Rendered as a clickable button on the client
      // timeline under the step it belongs to.
      link:        { type: String, default: '' },
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
  // If a structured quote exists, derive headline total + COGS from it so
  // every surface (card / dashboard / confirmation) agrees. Setup and
  // shipping are pass-through: they hit both the client total and COGS.
  if (Array.isArray(this.quoteLines) && this.quoteLines.length > 0) {
    const linesTotal = this.quoteLines.reduce((s, l) => {
      const unit = Number(l.unitPrice) || ((Number(l.blankCost) || 0) + (Number(l.printCost) || 0)) * (Number(l.markup) || 1);
      return s + (Number(l.qty) || 0) * unit;
    }, 0);
    const linesCogs = this.quoteLines.reduce((s, l) =>
      s + (Number(l.qty) || 0) * ((Number(l.blankCost) || 0) + (Number(l.printCost) || 0)), 0);
    const extras = (Number(this.setupCost) || 0) + (Number(this.shippingCost) || 0);
    this.totalValue = linesTotal + extras;
    this.cogs       = linesCogs + extras;
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
    const extras = (Number(set.setupCost) || 0) + (Number(set.shippingCost) || 0);
    const linesCogs = set.quoteLines.reduce((s, l) =>
      s + (Number(l.qty) || 0) * ((Number(l.blankCost) || 0) + (Number(l.printCost) || 0)), 0);
    set.cogs = linesCogs + extras;
    set.totalValue = set.quoteLines.reduce((s, l) => {
      const unit = Number(l.unitPrice) || ((Number(l.blankCost) || 0) + (Number(l.printCost) || 0)) * (Number(l.markup) || 1);
      return s + (Number(l.qty) || 0) * unit;
    }, 0) + extras;
  }
  if (u.$set) u.$set = set; else Object.assign(u, set);
  this.setUpdate(u);
  next();
});

module.exports = mongoose.model('Order', OrderSchema);
module.exports.deriveCompanyKey = deriveCompanyKey;
