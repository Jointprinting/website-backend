const mongoose = require('mongoose');

// Singleton state for the auto-advancing lead-finder frontier. One doc, key
// 'frontier'. The scheduler works `activeRegion` until it goes dry, then steps
// it forward along dispensaryFinder.NATIONAL_ROLLOUT (see decideFrontier). Kept
// tiny + separate from the per-run audit rows (LeadFinderRun), mirroring the
// JpwSchedulerState pattern.
const LeadFinderStateSchema = new mongoose.Schema({
  key:          { type: String, required: true, unique: true }, // always 'frontier'
  activeRegion: { type: String, default: 'nj' },
  dryStreak:    { type: Number, default: 0 },   // consecutive no-new-lead sweeps
  // Vestigial — the engine is always on now (no toggle); kept so old docs load.
  autoAdvance:  { type: Boolean, default: true },
  lastRunAt:    { type: Date, default: null },
  lastResult:   { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('LeadFinderState', LeadFinderStateSchema);
