// models/JpwSchedulerState.js
//
// One document per scheduled job (nightly_rescore, weekly_stale_audit).
// The scheduler upserts after each run so the Dashboard can render a
// "last ran 6 hours ago, processed 247 leads" status line.

const mongoose = require('mongoose');

const JpwSchedulerStateSchema = new mongoose.Schema({
  job:          { type: String, required: true, unique: true },
  ran_at:       Date,           // when the run started or last updated
  duration_ms:  Number,
  total:        Number,
  updated:      Number,
  attempted:    Number,
  audited:      Number,
  error:        { type: String, default: '' },

  // Manual-sweep job fields (extends the schema without breaking the other
  // jobs that don't use these). The sweep loop updates these every pair so
  // the frontend can poll `/api/jpw/search/sweep/status` and render a live
  // progress bar.
  status:           { type: String, default: '' },  // 'running' | 'completed' | 'stopped' | 'failed'
  pairs_done:       { type: Number, default: 0 },
  pairs_total:      { type: Number, default: 0 },
  current_pair:     { type: String, default: '' },  // 'Voorhees · Roofing' for the UI
  api_calls_used:   { type: Number, default: 0 },
  total_created:    { type: Number, default: 0 },
  total_merged:     { type: Number, default: 0 },
  total_skipped:    { type: Number, default: 0 },
  total_skipped_in_spider: { type: Number, default: 0 },
  stop_requested:   { type: Boolean, default: false },
  started_at:       Date,
  finished_at:      Date,
  halted_reason:    { type: String, default: '' },
});

module.exports = mongoose.model('JpwSchedulerState', JpwSchedulerStateSchema);
