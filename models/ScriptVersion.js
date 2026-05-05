// models/ScriptVersion.js
//
// One row per saved edit of a cold-call script line. Versions are scoped to
// (nodeId, field) so each piece of script content has its own history.
// The default (built-in) content lives in the frontend code — this collection
// only stores user-saved overrides.

const mongoose = require('mongoose');

const ScriptVersionSchema = new mongoose.Schema({
  // Which node in the cold-call tree this version belongs to. Matches the
  // keys in COLD_CALL_NODES on the frontend (e.g. 'start', 'intro', 'discovery').
  nodeId: { type: String, required: true, index: true },

  // Which field within that node — 'script', 'followUp', 'voicemail', 'direction'.
  field: {
    type: String,
    required: true,
    enum: ['script', 'followUp', 'voicemail', 'direction'],
  },

  // The edited content. For multi-line fields (script, followUp), lines are
  // separated by a blank line in this string. Frontend handles the split.
  text: { type: String, required: true, maxlength: 8000 },

  // Optional human label — defaults to a date stamp on the frontend if blank.
  label: { type: String, default: '' },

  createdAt: { type: Date, default: Date.now, index: true },
});

// Compound index for fast "all versions for this node+field" lookups
ScriptVersionSchema.index({ nodeId: 1, field: 1, createdAt: -1 });

module.exports = mongoose.model('ScriptVersion', ScriptVersionSchema);
