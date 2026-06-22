const mongoose = require('mongoose');

// Single-document store for the Google Drive connection. The studio admin
// connects one Google account (OAuth2) that the site pushes backups to, so
// there's only ever one of these. The refresh token is the durable credential —
// it's exchanged for a short-lived access token whenever a backup is uploaded.
const GoogleDriveAuthSchema = new mongoose.Schema({
  accessToken:          { type: String, default: '' },
  refreshToken:         { type: String, default: '' },
  accessTokenExpiresAt: { type: Date,   default: null },
  pendingState:         { type: String, default: '' },   // CSRF state for the in-flight OAuth handshake
  email:                { type: String, default: '' },   // which Google account is connected (for display)
  folderId:             { type: String, default: '' },   // the "Joint Printing Backups" Drive folder we create
  connectedAt:          { type: Date,   default: null },
  lastBackupAt:         { type: Date,   default: null },
  lastBackupName:       { type: String, default: '' },
  lastBackupBytes:      { type: Number, default: 0 },
  lastError:            { type: String, default: '' },   // surfaced in status so a failed push isn't silent
}, { timestamps: true });

module.exports = mongoose.model('GoogleDriveAuth', GoogleDriveAuthSchema);
