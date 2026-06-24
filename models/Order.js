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

// Default sales-tax rates (percent) for the owner's territory. Choosing a
// state in the confirmation's per-location shipTos PRE-FILLS that location's
// taxRate; the owner can always override per location. Keyed by USPS code.
const STATE_TAX_RATES = { NJ: 6.625, NY: 8, CT: 6.35, MA: 6.25, VT: 6, PA: 6 };

// Round-half-up to cents. Confirmation grand totals and tax lines are summed in
// floating point and MUST be snapped to cents at their final points, or they
// drift by fractions of a cent (a $2,203.3000000001 grand total). Number.EPSILON
// nudges values that are mathematically *.xx5 but land just under in binary
// (e.g. 1.005) up to the correct cent. Mirrored in every frontend copy.
const roundCents = (v) => Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;

// Is this add-on customLine a SALES-TAX line? A confirmation can carry a legacy
// flat/percent "NJ tax" customLine (the builder's one-tap preset) AND, on the
// newer multi-ship-to path, per-location taxRates. Applying both double-taxes the
// job. We detect a tax line by an explicit `isTax` flag (honored if present) or,
// for back-comp with already-saved confirmations that predate the flag, a label
// that mentions "tax". Kept deliberately broad on the label so a saved
// "NJ sales tax" / "Sales Tax" / "NY tax" line is all caught. Mirrored on the
// frontend so the builder preview, PDF, approval page and the order's stored
// total all agree.
function isTaxCustomLine(line) {
  if (!line) return false;
  if (line.isTax === true) return true;
  return /tax/i.test(String(line.label || ''));
}

// Per-location sales tax for a confirmation that ships to multiple destinations
// with their own tax rates. ACTIVE only when at least one shipTo carries a
// taxRate > 0 — otherwise this is a no-op and the grand total is byte-identical
// to a confirmation with no shipTos at all.
//
// Each item's merchandise revenue (Σ qty×unitPrice over its sizes) is allocated
// to a location PROPORTIONALLY by that location's share of the item's units:
//   locationItemRevenue = itemRevenue × (allocation.qty / itemTotalQty)
// This assumes the price mix is uniform across an item's units (the unit price
// is per size, not per destination), so revenue follows quantity. The sum over
// items is a location's taxable merchandise subtotal; × its taxRate% is that
// location's tax. Tax is on MERCHANDISE only (item revenue) — it does not stack
// on top of add-on customLines (CC fees, discounts), which is the correct sales
// tax base and avoids taxing a credit-card fee. When this is active, any legacy
// tax customLine is dropped by computeConfirmationTotals (see isTaxCustomLine),
// so a job is never taxed twice even on a saved confirmation that carries both.
// Mirrors the frontend _shared.js confLocationTax exactly.
function computeLocationTax(conf) {
  const n = (v) => Number(v) || 0;
  const shipTos = (conf && Array.isArray(conf.shipTos)) ? conf.shipTos : [];
  const taxed = shipTos.filter(st => st && n(st.taxRate) > 0);
  if (taxed.length === 0) return { active: false, total: 0, lines: [] };
  const items = (conf && Array.isArray(conf.items)) ? conf.items : [];
  const lines = taxed.map(st => {
    const subtotal = items.reduce((sum, it) => {
      const itemRevenue = ((it && it.sizes) || []).reduce((ss, sz) => ss + n(sz.qty) * n(sz.unitPrice), 0);
      const itemQty = ((it && it.sizes) || []).reduce((q, sz) => q + n(sz.qty), 0);
      if (itemQty <= 0) return sum;
      const allocQty = ((it && it.allocations) || []).reduce((q, a) => q + (a && a.key === st.key ? n(a.qty) : 0), 0);
      // Guard a bad allocation: a location's share of an item can't be negative
      // nor exceed the item's full quantity. Without this, an over-allocation
      // (allocations summing past itemQty) would tax MORE than the item's actual
      // revenue, and across locations the taxed base could exceed 100% of the
      // merchandise. Clamp so the taxed base stays within real item revenue.
      const share = allocQty <= 0 ? 0 : (allocQty >= itemQty ? 1 : allocQty / itemQty);
      return sum + itemRevenue * share;
    }, 0);
    const rate = n(st.taxRate);
    // Round each location's tax to cents — the line shown to the client and the
    // value summed into the grand total must be a real cent amount.
    const value = roundCents(subtotal * rate / 100);
    const label = `${st.label || st.name || 'Location'} tax - ${rate}%`;
    return { label, subtotal, rate, value };
  });
  // Sum the already-rounded line values (so total == Σ of the lines the client
  // sees), then re-round defensively.
  const total = roundCents(lines.reduce((s, l) => s + l.value, 0));
  return { active: true, total, lines };
}

// Confirmation grand total — items subtotal plus custom lines, where percent
// lines apply to the running subtotal in order. When the confirmation ships to
// multiple locations with their own tax rates, per-location tax is added LAST
// (the same place the single "NJ tax" customLine would land), so totalValue /
// finance pick it up identically. With no taxed shipTos this is byte-identical
// to before. Mirrors the builder preview, the server PDF (confirmationPdf.js)
// and the approval page exactly.
function computeConfirmationTotals(conf) {
  const n = (v) => Number(v) || 0;
  const items = (conf && Array.isArray(conf.items)) ? conf.items : [];
  const itemsSubtotal = items.reduce((s, it) =>
    s + ((it && it.sizes) || []).reduce((ss, sz) => ss + n(sz.qty) * n(sz.unitPrice), 0), 0);
  const locationTax = computeLocationTax(conf);
  let running = itemsSubtotal;
  ((conf && conf.customLines) || []).forEach(l => {
    // DOUBLE-TAX GUARD: when per-location tax is active, a legacy tax customLine
    // (the "NJ tax" preset) must NOT also apply — per-location tax wins, so the
    // job is taxed exactly once. With no per-location tax a legacy tax line still
    // applies (back-comp). The builder also suppresses the conflict going forward;
    // this keeps already-saved confirmations that carry both from double-taxing.
    if (locationTax.active && isTaxCustomLine(l)) return;
    running += l && l.isPercent ? running * n(l.amount) / 100 : n(l && l.amount);
  });
  running += locationTax.total;
  // Snap the grand total to cents (the order's stored totalValue, the client's
  // headline total, and the finance number all read this) so it can't drift by a
  // fraction of a cent off the summed lines.
  return { itemsSubtotal, grandTotal: roundCents(running) };
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
    // Optional multi-destination shipping. When EMPTY (the common case) the
    // order ships to the single `shipping` block above and nothing about the
    // doc, totals, PDF, or client page changes. When the client wants one
    // order split across several of their own locations, each destination is
    // captured here and items carry per-location `allocations` (below). Purely
    // additive — when empty, totals/PDF/finance are unchanged. When a location
    // sets a taxRate > 0, its allocated merchandise is taxed at that rate and
    // the sum is added to the grand total (see computeLocationTax).
    shipTos: [{
      key:          { type: String, default: '' },  // stable id linking allocations to this location
      label:        { type: String, default: '' },  // friendly name, e.g. "Brooklyn HQ"
      name:         { type: String, default: '' },  // ship-to company/recipient
      street:       { type: String, default: '' },
      cityStateZip: { type: String, default: '' },
      state:        { type: String, default: '' },  // USPS code; pre-fills taxRate from STATE_TAX_RATES
      taxRate:      { type: Number, default: 0 },    // sales-tax percent for this location (0 = untaxed)
      _id: false,
    }],
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
      printDetails:        { type: String, default: '' },    // decoration detail, e.g. "1 color front" — distinguishes a print variant (carried from the quote line)
      color:               { type: String, default: '' },
      printerName:         { type: String, default: '' },    // who's actually printing this item
      unitCost:            { type: Number, default: 0 },     // internal cost/unit carried from the quote — drives the order's COGS, never shown to the client
      sizes: [{
        label:     { type: String, default: '' },  // 'XS', 'S', ..., 'OS', or any custom
        qty:       { type: Number, default: 0 },
        unitPrice: { type: Number, default: 0 },
        _id: false,
      }],
      // Per-location split of THIS item's total quantity, keyed to
      // confirmation.shipTos[].key. Optional and additive: when absent (every
      // single-location order, and any item the owner hasn't split) the item
      // ships whole to the single `shipping` address and nothing changes. The
      // allocations are a logistics overlay only — they never feed totals, tax,
      // revenue, or COGS, which stay driven purely by `sizes` (qty × unitPrice).
      allocations: [{
        key: { type: String, default: '' },  // matches a confirmation.shipTos[].key
        qty: { type: Number, default: 0 },    // units of this item going to that location
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
      // Marks a line as sales tax so the double-tax guard can drop it when
      // per-location tax is active (see isTaxCustomLine). Legacy/unflagged tax
      // lines are still caught by the /tax/i label fallback.
      isTax:     { type: Boolean, default: false },
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
module.exports.computeLocationTax = computeLocationTax;
module.exports.STATE_TAX_RATES = STATE_TAX_RATES;
module.exports.hasConfirmationContent = hasConfirmationContent;
module.exports.isTaxCustomLine = isTaxCustomLine;
module.exports.roundCents = roundCents;
