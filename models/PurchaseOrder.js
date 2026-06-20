const mongoose = require('mongoose');

// Purchase order sent to a printer/vendor for one project. Mirrors the
// hand-made Google Docs POs ("{Vendor} x Joint Printing PO"): header info,
// shipping block, lettered product/print items with sub-detail lines, an
// order summary of charges, and a grand total. Everything is editable —
// vendors vary in what sections they need, so the doc stores what the
// builder shows, no hidden derivation.
const PurchaseOrderSchema = new mongoose.Schema({
  orderId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Order', index: true, required: true },
  poNumber:  { type: String, default: '' },          // "#007" — atomic via Counter('po')
  date:      { type: Date, default: Date.now },

  // Vendor block
  vendorName:    { type: String, default: '' },      // "Heritage Screen Printing"
  contactName:   { type: String, default: '' },      // "Jaide Thomas"
  vendorAddress: { type: String, default: '' },      // "331 York Rd, Warminster, PA 18974"

  // Shipping block (usually the client's delivery address)
  shipping: {
    name:          { type: String, default: '' },
    attention:     { type: String, default: '' },
    streetAddress: { type: String, default: '' },
    cityStateZip:  { type: String, default: '' },
  },
  shipMethod: { type: String, default: '' },          // "UPS Acct # JR2257"

  // Hard / in-hands due date the printer must hit (most POs carry one).
  dueDate:       { type: Date,    default: null },
  // Prints a "proof required before production run" line when true.
  proofRequired: { type: Boolean, default: false },

  // True for apparel jobs where JP supplies the garments — flips the section
  // header to "Product/Print Info - (blanks provided)".
  blanksProvided: { type: Boolean, default: false },

  // Lettered product items: "A) Glass Ashtrays, 100 units" with sub-bullets.
  items: [{
    title:   { type: String, default: '' },           // "Glass Ashtrays, 100 units"
    details: [{ type: String }],                       // ["$3.02/unit * 100 units = $302", "$40 setup"]
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
}, { timestamps: true });

module.exports = mongoose.model('PurchaseOrder', PurchaseOrderSchema);
