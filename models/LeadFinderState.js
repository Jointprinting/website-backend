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
  // Consecutive FAILED sweeps per region for this vertical ({ nj: 2, ... }).
  // A region lands here when runFinder THREW for it (Overpass down, timeout…);
  // it leaves the moment a sweep succeeds. The scheduler retries these FIRST on
  // the next sweep — before advancing the frontier — so a big state that errored
  // (NY, CA) is never silently skipped forever. Capped per finder version (see
  // leadFinderScheduler.retryableFailedRegions) so a permanently broken region
  // can't wedge the loop. Mixed (a plain region→count map); callers must
  // markModified('failedRegions') after mutating.
  failedRegions: { type: mongoose.Schema.Types.Mixed, default: {} },
  // Which finder version the failure ledger belongs to. A version bump wipes the
  // ledger (a smarter finder deserves fresh retries — and un-parks regions that
  // hit the retry cap under the old logic).
  failedRegionsVersion: { type: Number, default: 0 },
  // Vestigial — the engine is always on now (no toggle); kept so old docs load.
  autoAdvance:  { type: Boolean, default: true },
  lastRunAt:    { type: Date, default: null },
  lastResult:   { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('LeadFinderState', LeadFinderStateSchema);
