const mongoose = require('mongoose');

// One run of the dispensary lead finder — an audit row per sweep so the Studio
// can show "last NJ sweep: 214 found, 173 with email, 41 new" and the runner can
// tell how much of a region is already worked. Lightweight; pattern mirrors
// JpwSchedulerState/JpwApiUsage.
const LeadFinderRunSchema = new mongoose.Schema({
  region:   { type: String, default: '', index: true },
  // Which business VERTICAL this sweep hunted (services/leadVerticals.js) —
  // 'dispensary' (default), 'brewery', 'smoke-vape', 'medical'. Legacy rows have
  // no value → read as 'dispensary' (all history predates multi-vertical).
  // Indexed so the per-vertical frontier can find its own last-swept-per-region
  // cheaply.
  vertical: { type: String, default: 'dispensary', index: true },
  dryRun:   { type: Boolean, default: false },
  found:    { type: Number, default: 0 },   // dispensaries discovered in OSM
  withEmail:{ type: Number, default: 0 },   // had an email (from OSM or scrape)
  enriched: { type: Number, default: 0 },   // emails obtained by website scrape
  verified: { type: Number, default: 0 },   // emails that passed the MX/deliverability check
  skippedChains: { type: Number, default: 0 }, // big-chain / MSO locations skipped
  created:  { type: Number, default: 0 },   // new CRM leads (all have an email — mail merge)
  updated:  { type: Number, default: 0 },   // existing CRM records touched
  skipped:  { type: Number, default: 0 },   // no email / suppressed / no company / import error
  // Field-Map roster pins captured from this sweep (EVERY OSM find, including the
  // emailless ones that used to be discarded) — new pins + back-filled matches.
  rosterAdded:    { type: Number, default: 0 },
  rosterAttached: { type: Number, default: 0 },
  // The finder logic version that produced this run. The engine re-sweeps states
  // stamped below the current dispensaryFinder.FINDER_VERSION so improvements
  // propagate automatically. Undefined on legacy rows → read as 0 (stale).
  finderVersion: { type: Number, default: 0, index: true },
  // Non-empty ⇒ this sweep THREW (Overpass down / timed out) and produced NO
  // coverage — written by leadFinderScheduler.noteRegionFailure so the coverage
  // map can distinguish "tried and failed" from "never reached". Error rows are
  // excluded from version/coverage bookkeeping (see leadFinderRunner.staleRegions).
  error:    { type: String, default: '' },
}, { timestamps: true });

module.exports = mongoose.model('LeadFinderRun', LeadFinderRunSchema);
