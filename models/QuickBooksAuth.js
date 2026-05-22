const mongoose = require('mongoose');

// Single-document store for the QuickBooks Online connection. One Joint
// Printing company = one QBO realm, so there's only ever one of these.
const QuickBooksAuthSchema = new mongoose.Schema({
  realmId:               { type: String, default: '' },   // QBO company id
  accessToken:           { type: String, default: '' },
  refreshToken:          { type: String, default: '' },
  accessTokenExpiresAt:  { type: Date,   default: null },
  refreshTokenExpiresAt: { type: Date,   default: null },
  pendingState:          { type: String, default: '' },    // CSRF state for the in-flight OAuth handshake
  connectedAt:           { type: Date,   default: null },
  lastSyncAt:            { type: Date,   default: null },
}, { timestamps: true });

module.exports = mongoose.model('QuickBooksAuth', QuickBooksAuthSchema);
