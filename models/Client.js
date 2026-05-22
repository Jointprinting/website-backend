const mongoose = require('mongoose');

// One profile per unique company, keyed by the same companyKey the rest of
// the system uses. Stores the per-client info that should auto-fill on every
// new project for that client (default printer, supplier, markup) plus
// permanent CRM-style notes (payment terms, preferences, contact info).
const ClientSchema = new mongoose.Schema({
  companyKey:      { type: String, required: true, unique: true, index: true },
  companyName:     { type: String, default: '' },
  clientName:      { type: String, default: '' },
  email:           { type: String, default: '' },
  phone:           { type: String, default: '' },
  paymentTerms:    { type: String, default: '' },     // "Net 15", "50% upfront", etc.
  defaultPrinter:  { type: String, default: '' },
  defaultSupplier: { type: String, default: '' },
  defaultMarkup:   { type: Number, default: 0 },      // 0 = no default
  notes:           { type: String, default: '' },     // sticky internal notes that follow the client across projects
}, { timestamps: true });

module.exports = mongoose.model('Client', ClientSchema);
