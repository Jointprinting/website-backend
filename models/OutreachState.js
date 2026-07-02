const mongoose = require('mongoose');

// Tiny singleton state doc for the outreach sender engine — pattern mirrors
// JpwSchedulerState. `firstSendAt` anchors the deliverability warm-up ramp
// (services/outreachEngine.js rampCap): the daily cap starts small the week of
// the first-ever send and climbs weekly, so a fresh sending address builds
// reputation instead of getting flagged. last_run/last_result power the
// Studio's engine-status readout.
const OutreachStateSchema = new mongoose.Schema({
  key:         { type: String, required: true, unique: true }, // always 'engine'
  firstSendAt: { type: Date, default: null },
  last_run_at: { type: Date, default: null },
  last_result: { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('OutreachState', OutreachStateSchema);
