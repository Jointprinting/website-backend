// models/ClientError.js
//
// A crash that happened in someone's BROWSER.
//
// Until now the only record of one was a console.error in a tab nobody was
// looking at. AppErrorBoundary catches a render crash and shows a decent
// fallback — but on /approve/:projectId that fallback is being read by a client
// who is trying to approve an order, and the owner finds out only if they
// happen to phone in.
//
// AGGREGATED BY FINGERPRINT, not one document per occurrence. Two reasons, and
// the second is the important one:
//
//   1. The same bug hit by forty people is one thing to fix, and reading it as
//      one row with a count of forty is how you triage it.
//   2. The report endpoint is PUBLIC and unauthenticated — it has to be, because
//      the crash it reports may have taken the whole app down. One row per
//      occurrence would be an unbounded collection anyone on the internet can
//      grow. Upserting on a fingerprint means a flood of identical reports
//      increments a counter instead of inserting rows.

const mongoose = require('mongoose');
const { applyLiveScope } = require('../utils/archiveScope');

const clientErrorSchema = new mongoose.Schema({
  // sha1 of (message + the first stack frame). Stable across sessions and users,
  // so the same bug from two different clients lands on one row.
  fingerprint: { type: String, required: true, unique: true, index: true },

  message: { type: String, default: '' },
  stack:   { type: String, default: '' },     // truncated at write time
  // Which of the three catchers saw it: a React render crash, a global window
  // error, or an unhandled promise rejection. They fail differently and are
  // worth telling apart.
  source:  { type: String, enum: ['render', 'window', 'promise'], default: 'window' },

  // WHERE. `route` is the path pattern, not the URL — /approve/:id, never the
  // token, which is the client's credential and must not be written to a log.
  route:      { type: String, default: '', index: true },
  clientFacing: { type: Boolean, default: false },   // was a CLIENT looking at this?

  count:     { type: Number, default: 1 },
  firstSeen: { type: Date, default: Date.now },
  lastSeen:  { type: Date, default: Date.now, index: true },

  // Coarse only. Enough to spot "every report is one old Safari" without
  // building a device fingerprint of the owner's clients.
  browsers: { type: [String], default: [] },

  // Triage. Resolving is a judgement, so it is recorded rather than inferred
  // from silence.
  resolved:   { type: Boolean, default: false },
  resolvedAt: { type: Date, default: null },
  note:       { type: String, default: '' },

  archived:   { type: Boolean, default: false, index: true },
  archivedAt: { type: Date, default: null },
});

// Newest unresolved first is the only listing that matters.
clientErrorSchema.index({ resolved: 1, lastSeen: -1 });

applyLiveScope(clientErrorSchema);

module.exports = mongoose.model('ClientError', clientErrorSchema);
