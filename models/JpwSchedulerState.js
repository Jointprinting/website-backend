// models/JpwSchedulerState.js
//
// One document per scheduled job (nightly_rescore, weekly_stale_audit).
// The scheduler upserts after each run so the Dashboard can render a
// "last ran 6 hours ago, processed 247 leads" status line.

const mongoose = require('mongoose');

const JpwSchedulerStateSchema = new mongoose.Schema({
  job:          { type: String, required: true, unique: true },
  ran_at:       Date,
  duration_ms:  Number,
  total:        Number,
  updated:      Number,
  attempted:    Number,
  audited:      Number,
  error:        { type: String, default: '' },
});

module.exports = mongoose.model('JpwSchedulerState', JpwSchedulerStateSchema);
