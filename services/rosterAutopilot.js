// services/rosterAutopilot.js
//
// Keeps the Field Map's license-roster coverage complete WITHOUT the owner
// pressing anything: every 6 hours (plus once shortly after boot) it ingests
// exactly ONE roster state — the first with zero roster rows (a never-loaded
// market, e.g. the medical states the ingest previously refused), else the
// stalest one past the refresh window. One state per tick keeps each pass
// cheap (one roster download + Mapbox geocoding of only the new rows) and
// spreads a full national refresh across a few days.
//
// Priority follows the lead engine's NATIONAL_ROLLOUT (NJ first, outward from
// home ground) so the states the owner actually drives fill first — PA, the
// emptiest market he crosses daily, lands within the first ticks of a deploy.
//
// Free by design: rosters are state open-data / community CSVs, geocoding is
// Mapbox's effectively-free tier. ROSTER_AUTOPILOT=off disables the loop.

const cron = require('node-cron');
const Dispensary = require('../models/Dispensary');
const { ROSTER_STATES } = require('./dispensaryStates');
const { ingestState } = require('./dispensaryIngest');
const { NATIONAL_ROLLOUT } = require('./dispensaryFinder');

const REFRESH_MS = 45 * 24 * 3600 * 1000;   // roster considered stale after 45 days

// Roster states in drive-priority order: rollout order first (region ids are
// lowercase state codes), then any roster state the rollout misses. Pure.
function rosterPriorityOrder(rollout = NATIONAL_ROLLOUT, states = ROSTER_STATES) {
  const inRollout = rollout.map((r) => r.toUpperCase()).filter((s) => states[s]);
  const rest = Object.keys(states).filter((s) => !inRollout.includes(s));
  return [...inRollout, ...rest];
}

// Which state should this tick load? The first NEVER-loaded state wins; else
// the stalest state past the refresh window; else none. `counts` and
// `freshest` are keyed by state code. Pure (exported for tests).
function pickRosterState({ order, counts, freshest, now = Date.now(), refreshMs = REFRESH_MS }) {
  for (const st of order) {
    if (!(counts[st] > 0)) return { state: st, reason: 'empty' };
  }
  let stalest = null;
  for (const st of order) {
    const at = freshest[st] ? new Date(freshest[st]).getTime() : 0;
    if (now - at < refreshMs) continue;
    if (!stalest || at < stalest.at) stalest = { state: st, at };
  }
  return stalest ? { state: stalest.state, reason: 'stale' } : null;
}

let _running = false;

async function tick() {
  if (_running) return;
  _running = true;
  try {
    const order = rosterPriorityOrder();
    const agg = await Dispensary.aggregate([
      { $match: { source: 'roster', state: { $in: order } } },
      { $group: { _id: '$state', count: { $sum: 1 }, freshest: { $max: '$lastVerifiedAt' } } },
    ]);
    const counts = {}, freshest = {};
    for (const a of agg) { counts[a._id] = a.count; freshest[a._id] = a.freshest; }
    const pick = pickRosterState({ order, counts, freshest });
    if (!pick) return;
    const report = await ingestState(pick.state);
    console.log(
      `[rosterAutopilot] ${pick.state} (${pick.reason}): +${report.created} new, ${report.updated} refreshed, `
      + `${report.deactivated} lapsed, ${report.totalActive} active (${report.sourceKind})`
    );
  } catch (err) {
    // A missing/moved roster just logs and yields the tick — the next tick
    // tries the next state in need (fetchRoster already reports per-source
    // errors to the manual ingest endpoint for debugging).
    console.warn('[rosterAutopilot] tick failed:', err.message);
  } finally {
    _running = false;
  }
}

function startRosterAutopilot() {
  if (String(process.env.ROSTER_AUTOPILOT || '').toLowerCase() === 'off') {
    console.log('[rosterAutopilot] disabled via ROSTER_AUTOPILOT=off');
    return;
  }
  // Boot kick after a polite delay (let Mongo/indexes settle), then every 6h
  // offset from the lead engine's tick so the two never contend.
  setTimeout(() => { tick(); }, 90_000);
  cron.schedule('20 */6 * * *', tick);
}

module.exports = {
  startRosterAutopilot,
  tick,
  // pure — unit-tested
  rosterPriorityOrder,
  pickRosterState,
  REFRESH_MS,
};
