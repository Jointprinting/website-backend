const mongoose = require('mongoose');

// One logo per company, keyed by the normalized companyKey so "Acme Co" and
// "Acme Co." share the same logo across every project.
const ClientLogoSchema = new mongoose.Schema({
  companyKey:   { type: String, required: true, unique: true, index: true },
  companyName:  { type: String, default: '' },
  imageDataUrl: { type: String, required: true },  // base64 data URL — small logos only
  uploadedAt:   { type: Date,   default: Date.now },
}, { timestamps: true });

module.exports = mongoose.model('ClientLogo', ClientLogoSchema);
