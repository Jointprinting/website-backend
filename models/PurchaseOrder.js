const mongoose = require('mongoose');

// Purchase order sent to a printer/vendor for one project. Mirrors the
// hand-made Google Docs POs ("{Vendor} x Joint Printing PO"): header info,
// shipping block, lettered product/print items with sub-detail lines, an
// order summary of charges, and a grand total. Everything is editable —
// vendors vary in what sections they need, so the doc stores what the
// builder shows, no hidden derivation.
const PurchaseOrderSchema = new mongoose.Schema({
  // An app-built PO always belongs to an order (the project it was generated from).
  // A PO LOADED from the owner's historical Drive PO files (the "rebuild" reconcile)
  // may reference a job that was never entered in-app, so orderId is OPTIONAL: such a
  // PO is vendor-only (it still shows on the printer's card + totals; the vendor↔order
  // link comes from the ledger spend instead). All readers already guard `orderId`.
  orderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true, default: null },
  poNumber:  { type: String, default: '' },          // "#007" — atomic via Counter('po')
  date:      { type: Date, default: Date.now },

  // Vendor block
  vendorName:    { type: String, default: '' },      // "Heritage Screen Printing"
  // Canonical vendor identity, derived from vendorName (utils/poCost.vendorKey —
  // the same key POs are already GROUPED and NUMBERED on, now persisted and
  // indexed so per-vendor queries stop scanning with a case-insensitive regex
  // that disagreed with its neighbours about whitespace). Derived, never
  // hand-set; the hook below keeps it in lockstep on every write path.
  vendorKey:     { type: String, default: '', index: true },
  contactName:   { type: String, default: '' },      // "Jaide Thomas"
  vendorAddress: { type: String, default: '' },      // "331 York Rd, Warminster, PA 18974"

  // Where Joint Printing ships the BLANKS to the printer — the printer's receiving
  // dock. JP supplies the blanks ~99% of the time, so almost every PO has this. It
  // was the field missing from the generated PDF vs. the owner's real PO. Defaults
  // to the vendor's own address (printers usually receive at the same place they're
  // based) but can be set independently when a printer receives elsewhere.
  shipToPrinter: {
    name:          { type: String, default: '' },     // printer / receiving name
    attention:     { type: String, default: '' },
    streetAddress: { type: String, default: '' },
    cityStateZip:  { type: String, default: '' },
  },

  // Where the FINISHED GOODS ship — usually the client's delivery / drop-ship
  // address. (Kept as `shipping` for back-compat with existing POs + seeders.)
  shipping: {
    name:          { type: String, default: '' },
    attention:     { type: String, default: '' },
    streetAddress: { type: String, default: '' },
    cityStateZip:  { type: String, default: '' },
  },
  shipMethod: { type: String, default: '' },          // "UPS Acct # JR2257"

  // The catalog key of the printer this PO is issued to (from the linked Vendor,
  // or carried from the confirmation item it was seeded from). A STABLE join to
  // the Printer price book the job was quoted on — lets Finances reconcile the
  // PO's real cost against the quote, per printer, without fuzzy name-matching.
  printerKey: { type: String, default: '', index: true },

  // Hard / in-hands due date the printer must hit (most POs carry one).
  dueDate:       { type: Date,    default: null },
  // Prints a "proof required before production run" line when true.
  proofRequired: { type: Boolean, default: false },

  // Who supplies the blanks. TRUE = JP does — flips the PO section header to
  // "Product/Print Info - (blanks provided)".
  //
  // The owner's rule is about the PRODUCT, not the vendor: apparel he buys from
  // S&S or an approved vendor and ships to the printer (true); promo products
  // — lighters, stress balls — the printer manufactures and prints itself
  // (false). utils/apparel derives this per PO from the items, reusing the
  // taxExempt flag the confirmation already carries for the NJ clothing
  // exemption; the vendor's remembered mode is only the fallback.
  //
  // Defaults TRUE to match Vendor.blanksProvided and because apparel is the
  // overwhelming majority. It used to default FALSE, so the SAME concept had
  // opposite defaults in the two models and any creator that didn't set it
  // explicitly silently asserted the rare case. Not cosmetic: expectedReceiptCats
  // (controllers/finances.js) reads `pos.some(p => p.blanksProvided === true)`
  // to decide whether a Blank COGS receipt is expected, so a defaulted-false PO
  // quietly switched OFF the missing-blanks-receipt nag for its whole order.
  blanksProvided: { type: Boolean, default: true },

  // Lettered product items: "A) Glass Ashtrays, 100 units" with sub-bullets.
  items: [{
    title:   { type: String, default: '' },           // "Glass Ashtrays, 100 units"
    details: [{ type: String }],                       // ["$3.02/unit * 100 units = $302", "$40 setup"]
    // The SAME numbers, structured. utils/poCost.buildPoLines already computes
    // every one of these to render the strings above, and then throws them away
    // — which is why parseUnitCost exists to regex them back out of the prose it
    // just wrote. Keeping them means per-unit cost, quantity and setup are
    // readable without parsing English, and a PO can be reconciled against the
    // quote it came from.
    //
    // All optional with no default beyond the schema's: an existing PO simply
    // has them empty and every current reader still works off `details`.
    qty:       { type: Number, default: null },
    unitCost:  { type: Number, default: null },
    setupCost: { type: Number, default: null },
    // Which confirmation item this line came from, so a PO can be re-derived or
    // diffed against the order rather than re-typed.
    lineKey:   { type: String, default: '' },
    _id: false,
  }],

  // Order summary charges that roll into the grand total.
  charges: [{
    label:  { type: String, default: '' },             // "Run Charge: $2.40/unit * 25 units"
    amount: { type: Number, default: 0 },              // 60
    _id: false,
  }],
  grandTotal: { type: Number, default: 0 },

  notes: { type: String, default: '' },                // free-form extra section

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  // A PO had no state at all. Emailing one to a printer wrote NOTHING to the
  // document, so "what is outstanding at a printer right now" was unanswerable,
  // and Vendor.leadTimeDays / qualityRating stayed hand-typed guesses with zero
  // readers because nothing measured them.
  //
  // `status` defaults to 'draft' and every existing PO reads as a draft, which
  // is true — none of them was ever marked sent. Nothing branches on it that did
  // not branch before.
  status: {
    type: String,
    default: 'draft',
    enum: ['draft', 'sent', 'acknowledged', 'in_production', 'shipped', 'received', 'cancelled'],
    index: true,
  },
  sentAt:         { type: Date, default: null },
  sentTo:         { type: String, default: '' },      // the address it actually went to
  sentBy:         { type: String, default: '' },      // AdminUser _id, '' = owner
  sendCount:      { type: Number, default: 0 },       // re-sends are a real signal
  acknowledgedAt: { type: Date, default: null },
  // Promised vs actual is the whole point: the difference IS the printer's
  // measured lead time and on-time record, instead of a number typed once.
  promisedShipDate: { type: Date, default: null },
  actualShipDate:   { type: Date, default: null },
  trackingNumber:   { type: String, default: '' },
  receivedAt:       { type: Date, default: null },
  // When the money left. The owner's rule: the lifecycle "should coincide with
  // when we pay it". Links to the ledger row rather than duplicating the amount.
  paidAt:           { type: Date, default: null },
  paidTxnId:        { type: String, default: '' },
  // Append-only trail of the transitions above, so a disputed delivery date has
  // a record instead of a recollection.
  events: [{
    kind: { type: String, default: '' },   // 'sent' | 'acknowledged' | 'shipped' | 'received' | 'paid' | 'cancelled'
    at:   { type: Date, default: Date.now },
    by:   { type: String, default: '' },
    note: { type: String, default: '' },
    _id: false,
  }],

  // Provenance + reversibility for the "Rebuild printers from Drive" reconcile
  // (controllers/vendorRebuild). `source` distinguishes an app-built PO ('' / 'app')
  // from one loaded from the owner's Drive PO history ('drive-rebuild'); sourceFileId
  // is the Drive doc id this PO was read from (idempotency key + the card's source
  // link). rebuildBatchId stamps every PO a rebuild run touches so the whole run is
  // revertible as a unit. Archive is SOFT (recoverable), mirroring the Vendor/CRM
  // archive — a rebuild supersedes the old auto-created in-app POs without deleting.
  source:        { type: String, default: '' },        // '' | 'drive-rebuild'
  sourceFileId:  { type: String, default: '' },        // Drive doc id (rebuild POs)
  rebuildBatchId:{ type: String, default: '', index: true },
  archived:      { type: Boolean, default: false, index: true },
  archivedAt:    { type: Date, default: null },
  archivedReason:{ type: String, default: '' },        // 'superseded-by-rebuild' | 'rebuild-revert' | …
}, { timestamps: true });

// Per-vendor PO lookups + the numbering/clash check are the hot path here, and
// they are always "this vendor, newest first".
PurchaseOrderSchema.index({ vendorKey: 1, archived: 1, poNumber: -1 });
// "What is outstanding at a printer right now" — the question the lifecycle
// fields exist to answer.
PurchaseOrderSchema.index({ archived: 1, status: 1, promisedShipDate: 1 });

const { attachVendorKeySync } = require('../utils/vendorKeySync');

attachVendorKeySync(PurchaseOrderSchema, 'vendorName');

module.exports = mongoose.model('PurchaseOrder', PurchaseOrderSchema);
