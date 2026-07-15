const mongoose = require('mongoose');

// Single-document store for the QuickBooks Online connection. The studio admin
// connects ONE QuickBooks company via OAuth2 (authorization-code flow), so there's
// only ever one of these. The refresh token is the durable credential — it's
// exchanged for a short-lived access token to read invoices/payments and (later)
// send the pay-at-close preorder payment links. Mirrors models/GoogleDriveAuth.
const QuickbooksAuthSchema = new mongoose.Schema({
  accessToken:           { type: String, default: '' },
  refreshToken:          { type: String, default: '' },
  accessTokenExpiresAt:  { type: Date,   default: null },   // ~1 hour
  refreshTokenExpiresAt: { type: Date,   default: null },   // ~100 days; re-consent needed after
  realmId:               { type: String, default: '' },     // the QuickBooks company id — every API call needs it
  companyName:           { type: String, default: '' },     // for the status display
  pendingState:          { type: String, default: '' },     // CSRF state for the in-flight OAuth handshake
  connectedAt:           { type: Date,   default: null },
  lastError:             { type: String, default: '' },     // surfaced in status so a failure isn't silent
}, { timestamps: true });

module.exports = mongoose.model('QuickbooksAuth', QuickbooksAuthSchema);
