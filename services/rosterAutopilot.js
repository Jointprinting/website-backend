// services/rosterAutopilot.js
//
// Keeps the Field Map's license-roster coverage complete WITHOUT the owner
// pressing anything, two ways:
//
//   1. A background tick (every 6 hours + once shortly after boot) loads the
//      states most in need — never-loaded markets first in drive-priority
//      order, then stale refreshes — up to a few per tick so a cold database
//      fills in days, not weeks.
//   2. An ON-DEMAND hook (ensureStateRoster) the Field Map's viewport scan
//      calls when the owner is LOOKING AT an unseeded state — hovering
//      Cleveland with zero OH roster rows kicks the OH ingest right then, so
//      pins land while they're still looking, not next tick.
//
// Hard-won rules encoded here:
//   • States with no machine-readable roster (kind 'google' — Delaware) are
//     SKIPPED entirely: picking one as "first empty state" and failing wedged
//     the whole queue on DE forever while OH sat empty.
//   • A failed ingest (moved URL, source down) cools that state down for 6h
//     and the tick moves ON to the next candidate — one bad source can never
//     block the states behind it again.
//
// Free by design: rosters are state open-data / community CSVs, geocoding is
// Mapbox's effectively-free tier. ROSTER_AUTOPILOT=off disables the loop
// (the on-demand hook stays live — it only ever loads a state the owner is
// actively looking at).

const cron = require('node-cron');
const Dispensary = require('../models/Dispensary');
const { ROSTER_STATES } = require('./dispensaryStates');
const { ingestState } = require('./dispensaryIngest');
const { NATIONAL_ROLLOUT } = require('./dispensaryFinder');

const REFRESH_MS = 45 * 24 * 3600 * 1000;   // roster considered stale after 45 days
const FAIL_COOLDOWN_MS = 6 * 3600 * 1000;   // don't re-hit a broken source for 6h
const MAX_PER_TICK = 3;                      // states loaded per background tick

// Roster states in drive-priority order: rollout order first (region ids are
// lowercase state codes), then any roster state the rollout misses. States
// with no machine-readable roster (kind 'google') are excluded — they seed
// via sweeps/OSM, and retrying their impossible ingest wedges the queue. Pure.
function rosterPriorityOrder(rollout = NATIONAL_ROLLOUT, states = ROSTER_STATES) {
  const loadable = (s) => states[s] && states[s].roster && states[s].roster.kind !== 'google';
  const inRollout = rollout.map((r) => r.toUpperCase()).filter(loadable);
  const rest = Object.keys(states).filter((s) => loadable(s) && !inRollout.includes(s));
  return [...inRollout, ...rest];
}

// The ordered work list for a tick: every NEVER-loaded state first (in
// priority order), then stale states (stalest first). `skip` holds states to
// pass over this round (failure cooldown / already in flight). Pure
// (exported for tests).
function pickRosterStates({ order, counts, freshest, skip = new Set(), now = Date.now(), refreshMs = REFRESH_MS } = {}) {
  const out = [];
  for (const st of order || []) {
    if (skip.has(st)) continue;
    if (!((counts || {})[st] > 0)) out.push({ state: st, reason: 'empty' });
  }
  const stale = [];
  for (const st of order || []) {
    if (skip.has(st)) continue;
    if (!((counts || {})[st] > 0)) continue; // already queued as empty
    const at = (freshest || {})[st] ? new Date(freshest[st]).getTime() : 0;
    if (now - at >= refreshMs) stale.push({ state: st, reason: 'stale', at });
  }
  stale.sort((a, b) => a.at - b.at);
  return out.concat(stale.map(({ state, reason }) => ({ state, reason })));
}

// Module state: one ingest per state at a time, and a cooldown after failure
// so a broken source is skipped instead of hammered. In-memory is fine — a
// restart just retries, and ingest itself is idempotent.
const _inflight = new Set();
const _failedAt = new Map();

// Load one state's roster if it's loadable and not on cooldown/in flight.
// Safe to fire-and-forget (never throws). Returns the ingest report or null.
async function ensureStateRoster(state, { reason = 'on-demand' } = {}) {
  const st = String(state || '').toUpperCase();
  const cfg = ROSTER_STATES[st];
  if (!cfg || !cfg.roster || cfg.roster.kind === 'google') return null;
  if (_inflight.has(st)) return null;
  const failed = _failedAt.get(st);
  if (failed && Date.now() - failed < FAIL_COOLDOWN_MS) return null;
  _inflight.add(st);
  try {
    const report = await ingestState(st);
    _failedAt.delete(st);
    console.log(
      `[rosterAutopilot] ${st} (${reason}): +${report.created} new, ${report.updated} refreshed, `
      + `${report.deactivated} lapsed, ${report.totalActive} active (${report.sourceKind})`
    );
    return report;
  } catch (err) {
    _failedAt.set(st, Date.now());
    console.warn(`[rosterAutopilot] ${st} ingest failed (cooling down 6h):`, err.message);
    return null;
  } finally {
    _inflight.delete(st);
  }
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
    const skip = new Set([..._inflight, ..._failedAt.keys()].filter((st) => {
      const f = _failedAt.get(st);
      return _inflight.has(st) || (f && Date.now() - f < FAIL_COOLDOWN_MS);
    }));
    const candidates = pickRosterStates({ order, counts, freshest, skip });
    let loaded = 0;
    for (const { state, reason } of candidates) {
      if (loaded >= MAX_PER_TICK) break;
      const report = await ensureStateRoster(state, { reason }); // eslint-disable-line no-await-in-loop
      if (report) loaded += 1;
      // A failure just cools that state down — keep walking the list.
    }
  } catch (err) {
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
  ensureStateRoster,
  // pure — unit-tested
  rosterPriorityOrder,
  pickRosterStates,
  REFRESH_MS,
};
