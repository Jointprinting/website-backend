const mongoose = require('mongoose');

// Printer / promo-vendor contact book. Remembered from each PO so the next
// one for the same vendor pre-fills contact + address + ship method.
const VendorSchema = new mongoose.Schema({
  name:        { type: String, default: '', index: true },
  contactName: { type: String, default: '' },
  email:       { type: String, default: '' },
  address:     { type: String, default: '' },
  shipMethod:  { type: String, default: '' },   // default "UPS Acct # ..." note
  blanksProvided: { type: Boolean, default: false }, // typical mode for this vendor
}, { timestamps: true });

module.exports = mongoose.model('Vendor', VendorSchema);
