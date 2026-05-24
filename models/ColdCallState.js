const mongoose = require('mongoose');

// Single-document store for the JPW Cold Call Tree's edits + notes. Previously
// these lived in browser localStorage — durable enough for one device but
// fragile (a Clear Site Data wipes everything, and notes never followed the
// user to another machine). One document since this is single-admin.
//
// `overrides` is keyed `${nodeId}::${field}` → edited text.
const ColdCallStateSchema = new mongoose.Schema({
  biz:       { type: String, default: '' },
  svc:       { type: String, default: '' },
  name:      { type: String, default: '' },
  notes:     { type: String, default: '' },
  overrides: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
}, { timestamps: true });

module.exports = mongoose.model('ColdCallState', ColdCallStateSchema);
