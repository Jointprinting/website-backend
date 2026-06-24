const mongoose = require('mongoose');

// One remembered association of "this vendor printed this order #". Learned
// CONSERVATIVELY when a receipt/expense is booked with a vendor + an order # (see
// controllers/receipts.confirm): a remembered HINT, never an irreversible action.
// It lets a future PO/receipt for that order pre-fill the printer that actually
// did it, and it surfaces on the vendor card as the orders they've been paid for.
// orderNumber is the canonical (digits-only, leading-zeros-stripped) key so it
// lines up with the finance ledger; `at` is when it was last seen for recency.
const VendorOrderLinkSchema = new mongoose.Schema({
  orderNumber: { type: String, default: '' },   // normalizeOrderNumber key, e.g. "21"
  at:          { type: Date,   default: Date.now },
  _id: false,
});

// Printer / promo-vendor contact book. Remembered from each PO so the next
// one for the same vendor pre-fills contact + address + ship method. This is
// also the supplier's DETAIL CARD record — the connected-database hub that ties
// together every PO, order, and receipt/expense for the printer (see
// controllers/purchaseOrders.getVendor).
const VendorSchema = new mongoose.Schema({
  name:        { type: String, default: '', index: true },
  contactName: { type: String, default: '' },
  email:       { type: String, default: '' },
  phone:       { type: String, default: '' },
  address:     { type: String, default: '' },
  shipMethod:  { type: String, default: '' },   // default "UPS Acct # ..." note
  accountNumber: { type: String, default: '' }, // our account # with this vendor
  notes:       { type: String, default: '' },
  // Typical mode for this vendor. Defaults TRUE because Joint Printing supplies
  // the blanks ~99% of the time — so an unset/new vendor seeds POs with blanks
  // provided (blank cost excluded from the supplier PO). The PO seeders read this
  // (createPo / createPosFromConfirmation) and the builder writes it back per PO.
  blanksProvided: { type: Boolean, default: true },

  // Owner-set "next PO #" for this vendor. The app auto-numbers POs per vendor
  // from an atomic counter (utils/sequence), but the owner's REAL historical run
  // (e.g. Heritage POs up to ~8 in Google Drive) is invisible to that counter, so
  // the app collided at #004. Setting this seeds the floor: the auto-assigner uses
  // max(stored counter, nextPoStart), and on save we bump the atomic counter up to
  // it so the sequence stays collision-safe. 0/unset = no owner floor (start at 1).
  nextPoStart: { type: Number, default: 0 },

  // Conservative learned vendor↔order links (see VendorOrderLinkSchema). Keyed by
  // canonical order number; we keep one entry per order, refreshing `at`.
  vendorOrders: { type: [VendorOrderLinkSchema], default: [] },
}, { timestamps: true });

module.exports = mongoose.model('Vendor', VendorSchema);
