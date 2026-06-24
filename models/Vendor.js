const mongoose = require('mongoose');

// Printer / promo-vendor contact book. Remembered from each PO so the next
// one for the same vendor pre-fills contact + address + ship method.
const VendorSchema = new mongoose.Schema({
  name:        { type: String, default: '', index: true },
  contactName: { type: String, default: '' },
  email:       { type: String, default: '' },
  address:     { type: String, default: '' },
  shipMethod:  { type: String, default: '' },   // default "UPS Acct # ..." note
  // Typical mode for this vendor. Defaults TRUE because Joint Printing supplies
  // the blanks ~99% of the time — so an unset/new vendor seeds POs with blanks
  // provided (blank cost excluded from the supplier PO). The PO seeders read this
  // (createPo / createPosFromConfirmation) and the builder writes it back per PO.
  blanksProvided: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model('Vendor', VendorSchema);
