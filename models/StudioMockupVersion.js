const mongoose = require('mongoose');

// Durable, cloud-side history of a mockup's versions — the backing store for the
// studio's "🕘 History → Restore" so prior versions survive a device wipe. The
// studio is local-first (IndexedDB); this is the synced mirror. Mirrors the
// StudioLibraryItem storage approach: the heavy front/back composites live in
// `thumbnail`/`data` (offloaded to R2 when configured) and `pageState` is the
// trimmed, base64-stripped snapshot — so a version doc stays well under Mongo's
// 16MB ceiling and a history LIST never drags megabytes across the wire.
const StudioMockupVersionSchema = new mongoose.Schema({
  mockupRemoteId:  { type: String, required: true, index: true }, // the mockup these belong to
  versionRemoteId: { type: String, default: '', index: true },    // client UUID per version (dedup across devices)
  name:       { type: String, default: '' },
  mockupNum:  { type: String, default: '' },
  client:     { type: String, default: '' },
  trigger:    { type: String, default: 'edit' },   // 'open' | 'save'
  hash:       { type: String, default: '' },        // content hash — skip storing an unchanged snapshot
  thumbnail:  { type: String, default: '' },        // front composite (R2 URL once offloaded)
  data:       { type: String, default: '' },        // back composite (R2 URL once offloaded)
  pageState:  { type: mongoose.Schema.Types.Mixed, default: null }, // trimmed snapshot (heavy base64 stripped)
  savedAt:    { type: Number, default: () => Date.now() },
}, { timestamps: true });

// Per-mockup, newest first — the only access pattern (list + prune).
StudioMockupVersionSchema.index({ mockupRemoteId: 1, savedAt: -1 });

module.exports = mongoose.model('StudioMockupVersion', StudioMockupVersionSchema);
