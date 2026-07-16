const mongoose = require('mongoose');

// One logo per company, keyed by the normalized companyKey so "Acme Co" and
// "Acme Co." share the same logo across every project.
const ClientLogoSchema = new mongoose.Schema({
  companyKey:   { type: String, required: true, unique: true, index: true },
  companyName:  { type: String, default: '' },
  imageDataUrl: { type: String, required: true },  // base64 data URL — small logos only
  uploadedAt:   { type: Date,   default: Date.now },
  // Soft-delete (house rule: nothing is hard-deleted). Deleting a logo, or merging a
  // company away, archives it instead of dropping the row — so a "delete" or a merge
  // is recoverable, never a silent data loss. The companyKey stays unique across
  // archived + live (one logo per company either way); a re-upload for the same key
  // revives the archived doc (upsert opts into withArchived to reach it).
  archived:       { type: Boolean, default: false, index: true },
  archivedAt:     { type: Date, default: null },
  archivedReason: { type: String, default: '' },   // 'merged' | 'manual'
  mergedInto:     { type: String, default: '' },    // survivor companyKey when reason === 'merged'
}, { timestamps: true });

// Every logo read (list + the client-facing approval/lookbook/preorder/portal
// lookups) excludes archived rows; the upsert/merge writes opt in via withArchived
// to revive an archived doc rather than collide on the unique companyKey index.
require('../utils/archiveScope').applyLiveScope(ClientLogoSchema);

module.exports = mongoose.model('ClientLogo', ClientLogoSchema);
