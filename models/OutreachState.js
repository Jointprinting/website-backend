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
  // O(1) daily-sent counter (ET day). Avoids re-aggregating every enrollment's
  // unbounded sends[] on every 15-min tick just to enforce the daily cap; seeds
  // itself from the authoritative scan once per day at rollover (engine
  // getSentToday), then $inc's per send.
  sentToday:     { type: Number, default: 0 },
  sentTodayDate: { type: String, default: '' }, // "YYYY-MM-DD" in ET
}, { timestamps: true });

module.exports = mongoose.model('OutreachState', OutreachStateSchema);
