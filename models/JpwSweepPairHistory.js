// models/JpwSweepPairHistory.js
//
// Tracks every (category × town) combination the sweep has ever run, with the
// timestamp + result counts of the most recent visit. Powers the smart queue
// (`getNextSweepPairs`) so Lead Recon never thinks twice about which pairs to
// search next — it just picks the oldest.
//
// Side benefit: zero-yield pairs (well-drilling in Cherry Hill) can be
// deprioritized for N days based on `last_result_count === 0`, so we don't
// burn API quota on combos we already know are dry.

const mongoose = require('mongoose');

const JpwSweepPairHistorySchema = new mongoose.Schema({
  category:                 { type: String, required: true },
  town:                     { type: String, default: '' },
  county:                   { type: String, default: '' },
  last_ran_at:              { type: Date, required: true },
  last_result_count:        { type: Number, default: 0 }, // unique businesses ingested
  last_created:             { type: Number, default: 0 },
  last_merged:              { type: Number, default: 0 },
  last_skipped_in_spider:   { type: Number, default: 0 },
  last_api_calls_used:      { type: Number, default: 0 },
  total_runs:               { type: Number, default: 0 },
});

// Compound unique index — one row per (category, town) combo.
JpwSweepPairHistorySchema.index({ category: 1, town: 1 }, { unique: true });
// Helper index for the smart-queue sort by oldest-first.
JpwSweepPairHistorySchema.index({ last_ran_at: 1 });

module.exports = mongoose.model('JpwSweepPairHistory', JpwSweepPairHistorySchema);
