const mongoose = require('mongoose');

function deriveCompanyKey(companyName, clientName) {
  const raw = (companyName || clientName || '').toString();
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Quote totals from the lines. Setup + shipping are per-line now — each option
// carries its FULL setup/shipping, spread across its own quantity into the unit
// cost (so 3 alternative options each bear the full cost, never shared). Legacy
// order-level setup/shipping are only folded in when no line carries its own,
// so pre-existing quotes keep their totals until they're re-saved.
function computeQuoteTotals(lines, orderSetup, orderShip) {
  let arr = Array.isArray(lines) ? lines : [];
  // Once the client has picked options, only accepted lines are the real
  // order — summing all alternatives would inflate the total (3 brands of
  // tee the client picks ONE of). Standalone (ungrouped) lines are always
  // part of the order, so they count alongside the accepted picks.
  if (arr.some(l => l && l.accepted)) {
    // Groups added AFTER the client picked have no accepted line yet — keep
    // all their alternatives counted (pre-pick behavior) rather than silently
    // dropping the whole group from the totals.
    const decided = new Set(arr.filter(l => l && l.accepted).map(l => l.group));
    arr = arr.filter(l => l && (l.accepted || !l.group || !decided.has(l.group)));
  }
  const n = (v) => Number(v) || 0;
  const perLineExtras = arr.reduce((s, l) => s + n(l.setupCost) + n(l.shippingCost), 0);
  const legacy = perLineExtras === 0 ? (n(orderSetup) + n(orderShip)) : 0;
  const totalValue = arr.reduce((s, l) => {
    const qty = n(l.qty);
    const setupShip = n(l.setupCost) + n(l.shippingCost);
    const unitCogs = n(l.blankCost) + n(l.printCost) + (qty > 0 ? setupShip / qty : 0);
    const unit = n(l.unitPrice) || unitCogs * (n(l.markup) || 1);
    return s + qty * unit;
  }, 0) + legacy;
  const cogs = arr.reduce((s, l) =>
    s + n(l.qty) * (n(l.blankCost) + n(l.printCost)) + n(l.setupCost) + n(l.shippingCost), 0) + legacy;
  return { totalValue, cogs };
}

// Confirmation grand total — items subtotal plus custom lines, where percent
// lines apply to the running subtotal in order. Mirrors the builder preview,
// the server PDF (confirmationPdf.js) and the approval page exactly.
function computeConfirmationTotals(conf) {
  const n = (v) => Number(v) || 0;
  const items = (conf && Array.isArray(conf.items)) ? conf.items : [];
  const itemsSubtotal = items.reduce((s, it) =>
    s + ((it && it.sizes) || []).reduce((ss, sz) => ss + n(sz.qty) * n(sz.unitPrice), 0), 0);
  let running = itemsSubtotal;
  ((conf && conf.customLines) || []).forEach(l => {
    running += l && l.isPercent ? running * n(l.amount) / 100 : n(l && l.amount);
  });
  return { itemsSubtotal, grandTotal: running };
}

// A confirmation only becomes the pricing source of truth once it has real
// content — an empty sub-document (every order has one) must not zero totals.
function hasConfirmationContent(conf) {
  if (!conf) return false;
  const items = Array.isArray(conf.items) ? conf.items : [];
  const lines = Array.isArray(conf.customLines) ? conf.customLines : [];
  return items.length > 0 || lines.length > 0;
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
  // When the client submitted their option picks on the approval page (the
  // interactive quote stage). Cleared conceptually by a new approval cycle —
  // compare against approvalSupersededAt.
  optionsPickedAt:        { type: Date,   default: null },
  approvalEvents: [{                                    // log of client interactions on the approval page
    kind:    { type: String },          // 'viewed' | 'approved' | 'requested_changes'
    message: { type: String, default: '' },
    by:      { type: String, default: '' },   // name the client optionally gave when acting
    email:   { type: String, default: '' },   // email the client optionally gave when acting
    at:      { type: Date, default: Date.now },
    _id: false,
  }],
  // Everyone the shared approval link has been emailed to. The link itself is a
  // single shared "hub" token — all recipients use the same URL — so this is
  // just the guest list, surfaced back in the admin Share dialog. Deduped by
  // email in the controller.
  approvalRecipients: [{
    email:  { type: String },
    sentAt: { type: Date, default: Date.now },
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
      unitCost:            { type: Number, default: 0 },     // internal cost/unit carried from the quote — drives the order's COGS, never shown to the client
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
    // Lines sharing a `group` label ("Bucket Hats") are alternative brand
    // options the client picks ONE of on the approval page. Ungrouped lines
    // are standalone (always included). `accepted` records the client's pick.
    group:        { type: String, default: '' },
    accepted:     { type: Boolean, default: false },
    // The design the client signs off when picking this option: a studio
    // mockup number, and/or an uploaded image (data URL or hosted URL) for
    // items the vendor renders externally — glass ashtrays etc. have no
    // mockup number.
    mockupNum:    { type: String, default: '' },
    image:        { type: String, default: '' },
    qty:          { type: Number, default: 0 },
    styleCode:    { type: String, default: '' },
    description:  { type: String, default: '' },
    color:        { type: String, default: '' },
    supplier:     { type: String, default: '' },
    blankCost:    { type: Number, default: 0 },   // per unit
    printType:    { type: String, default: '' },  // e.g. "Screen Print", "DTG", "Embroidery"
    printDetails: { type: String, default: '' },  // e.g. "1 color front + 2 color back"
    printCost:    { type: Number, default: 0 },   // per unit
    setupCost:    { type: Number, default: 0 },   // full one-time setup for THIS option; spread across this line's qty
    shippingCost: { type: Number, default: 0 },   // full shipping for THIS option; spread across this line's qty
    markup:       { type: Number, default: 1.4 }, // multiplier; unit price = (blankCost + printCost + (setup+ship)/qty) * markup; matches the builder default
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

// Totals lifecycle — one source of truth per stage:
//   - Quote stage (no confirmation content): totalValue/cogs derive from
//     quoteLines, so every surface (card / dashboard) agrees with the quote.
//   - Confirmation stage: the confirmation grand total is what the client
//     actually approves, so it becomes totalValue. cogs stays quote-derived
//     (the confirmation carries no cost data).
// Recomputes are gated on the fields actually changing, so unrelated saves
// (approval-token rotation, tracking ticks) can't clobber a hand-corrected
// total.
OrderSchema.pre('save', function (next) {
  this.companyKey = deriveCompanyKey(this.companyName, this.clientName);
  const lines = Array.isArray(this.quoteLines) ? this.quoteLines : [];
  // On brand-new docs only react to actual content — imports and manual
  // creates carry a hand-set totalValue with no quote lines, and the old
  // length>0 guard kept those intact.
  const quoteTouched = this.isNew ? lines.length > 0 : this.isModified('quoteLines');
  const confTouched  = this.isNew
    ? hasConfirmationContent(this.confirmation)
    : this.isModified('confirmation');
  if (quoteTouched) {
    const t = computeQuoteTotals(lines, this.setupCost, this.shippingCost);
    this.cogs = t.cogs;
    if (!hasConfirmationContent(this.confirmation)) this.totalValue = t.totalValue;
  }
  if ((confTouched || quoteTouched) && hasConfirmationContent(this.confirmation)) {
    this.totalValue = computeConfirmationTotals(this.confirmation).grandTotal;
  }
  next();
});

OrderSchema.pre('findOneAndUpdate', async function () {
  const u = this.getUpdate() || {};
  const set = u.$set || u;
  if (set.companyName !== undefined || set.clientName !== undefined) {
    set.companyKey = deriveCompanyKey(set.companyName, set.clientName);
  }
  if (Array.isArray(set.quoteLines)) {
    const t = computeQuoteTotals(set.quoteLines, set.setupCost, set.shippingCost);
    set.cogs = t.cogs;
    // The confirmation total stays authoritative if one exists — look it up
    // when this update doesn't carry it.
    let conf = set.confirmation;
    if (conf === undefined) {
      const doc = await this.model.findOne(this.getQuery()).select('confirmation').lean();
      conf = doc && doc.confirmation;
    }
    set.totalValue = hasConfirmationContent(conf)
      ? computeConfirmationTotals(conf).grandTotal
      : t.totalValue;
  } else if (set.confirmation !== undefined && hasConfirmationContent(set.confirmation)) {
    set.totalValue = computeConfirmationTotals(set.confirmation).grandTotal;
  }
  if (u.$set) u.$set = set; else Object.assign(u, set);
  this.setUpdate(u);
});

module.exports = mongoose.model('Order', OrderSchema);
module.exports.deriveCompanyKey = deriveCompanyKey;
module.exports.computeQuoteTotals = computeQuoteTotals;
module.exports.computeConfirmationTotals = computeConfirmationTotals;
module.exports.hasConfirmationContent = hasConfirmationContent;
