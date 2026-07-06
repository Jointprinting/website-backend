// services/leadFinderScheduler.js
//
// The long-term, self-refilling lead machine. Instead of a fixed weekly sweep,
// the auto-pilot is QUEUE-AWARE: it checks how many cold leads are sitting ready
// to enroll and only sweeps when that pool runs low — then it sweeps SEVERAL
// states in one run (advancing along NATIONAL_ROLLOUT) until it's topped the
// pool back up. So supply tracks the owner's sending automatically: send faster,
// it refills more; sit idle, it stays quiet. NJ → NY → PA → … → wraps at the end
// to re-catch newly opened shops.
//
// MULTI-VERTICAL: each business vertical (dispensaries, breweries, …) sweeps on
// its OWN frontier and its OWN supply gate, so a full dispensary pool can't starve
// a fresh brewery campaign. A tick sweeps every ACTIVE vertical — dispensaries
// (always, the core business) plus any vertical that has an active campaign.
//
// FAILURE LEDGER: a state whose sweep THROWS is never silently abandoned. The
// frontier still advances (one bad state can't wedge the run), but the failure
// is recorded — an error LeadFinderRun row for the coverage map, plus a
// consecutive-failure count on the vertical's state doc — and the NEXT sweep
// retries errored states FIRST, before expanding into fresh ground. Capped at
// MAX_REGION_ATTEMPTS per finder version so a permanently broken region parks
// instead of looping.
//
// Free ($0 — OSM + own-site scraping). ALWAYS ON — there is no toggle. The
// owner wants leads to stack up behind the scenes without operating anything;
// the queue-aware gate above is the only throttle. Pattern mirrors
// services/jpwScheduler.js.

const cron = require('node-cron');
const LeadFinderState = require('../models/LeadFinderState');
const LeadFinderRun = require('../models/LeadFinderRun');
const OutreachCampaign = require('../models/OutreachCampaign');
const { runFinder, countAvailableColdLeads, staleRegions } = require('./leadFinderRunner');
const { nextRegionAfter, isRegion, DEFAULT_REGION, REGIONS } = require('./dispensaryFinder');
const { getVertical, isVertical, frontierStateKey, DEFAULT_VERTICAL_ID } = require('./leadVerticals');

// Refill when the enrollable-cold-lead pool drops below this…
const LOW_WATERMARK = parseInt(process.env.LEAD_FINDER_LOW_WATERMARK || '40', 10);
// …and keep sweeping states until we've added this many new (emailable) leads.
// Every finder lead has an email — it's a mail-merge engine — so new == sendable.
const REFILL_TARGET = parseInt(process.env.LEAD_FINDER_REFILL_TARGET || '75', 10);
// …but never more than this many states in a single run (politeness cap).
const MAX_REGIONS_PER_RUN = parseInt(process.env.LEAD_FINDER_MAX_REGIONS || '6', 10);
// When the pool is HEALTHY but the finder has since improved, re-milk at most
// this many already-swept states per tick to upgrade their coverage in the
// background (so improvements land with no manual "re-sweep"). Small + polite.
const MAX_UPGRADE_PER_RUN = parseInt(process.env.LEAD_FINDER_MAX_UPGRADE || '3', 10);
// How many times an ERRORED region is retried (per finder version) before it's
// parked. 3 attempts distinguishes "Overpass had a bad day" (recovers on retry)
// from "this region is genuinely broken for this finder" (stop burning the
// sweep budget on it). A finder-version bump wipes the ledger and un-parks.
const MAX_REGION_ATTEMPTS = parseInt(process.env.LEAD_FINDER_MAX_REGION_ATTEMPTS || '3', 10);

// Which errored regions the next sweep should retry FIRST, before advancing the
// frontier into fresh ground. `failedRegions` is the per-vertical state doc's
// region→consecutive-failure-count ledger. The old behavior — log "(error)" and
// advance anyway — meant one Overpass timeout on a big state (NY, CA…) skipped
// it until the frontier WRAPPED the whole country, i.e. silently dropped the
// biggest markets. Least-tried first (fairest), capped so a permanently broken
// region can't loop forever. Pure + unit-tested.
function retryableFailedRegions(failedRegions = {}, { maxAttempts = MAX_REGION_ATTEMPTS } = {}) {
  return Object.entries(failedRegions || {})
    .map(([region, count]) => [region, Number(count) || 0])
    .filter(([region, count]) => isRegion(region) && count > 0 && count < maxAttempts)
    .sort((a, b) => a[1] - b[1])
    .map(([region]) => region);
}

// A sweep that THREW never covered its state — record that honestly. Writes a
// LeadFinderRun audit row with `error` set (and finderVersion 0: no coverage was
// produced), so the Studio's coverage map can tell "we tried and it FAILED"
// apart from "the frontier never reached it". Also bumps the state doc's
// consecutive-failure count for the region so the next sweep retries it first
// (the caller saves the state doc). Never throws — an audit failure must not
// mask the sweep's own error handling.
async function noteRegionFailure(state, region, verticalId, err) {
  const failed = { ...(state.failedRegions || {}) };
  failed[region] = (Number(failed[region]) || 0) + 1;
  state.failedRegions = failed;
  state.markModified('failedRegions');
  await LeadFinderRun.create({
    region,
    vertical: verticalId,
    dryRun: false,
    finderVersion: 0,
    error: String((err && err.message) || err || 'sweep failed').slice(0, 500),
  }).catch(() => {});
}

// The mirror image: a region swept CLEANLY, so it leaves the failure ledger
// (its next error starts a fresh count — the ledger tracks CONSECUTIVE fails).
function clearRegionFailure(state, region) {
  if (!state.failedRegions || !(region in state.failedRegions)) return;
  const failed = { ...state.failedRegions };
  delete failed[region];
  state.failedRegions = failed;
  state.markModified('failedRegions');
}

// Get-or-create the per-vertical frontier state (dispensary keeps the original
// 'frontier' key — no migration; others get 'frontier:<id>').
async function getState(verticalId = DEFAULT_VERTICAL_ID) {
  const key = frontierStateKey(verticalId);
  return LeadFinderState.findOneAndUpdate(
    { key },
    { $setOnInsert: { key, activeRegion: DEFAULT_REGION } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

// Which verticals to sweep this tick: dispensaries always (the core business +
// backward-compatible always-on), plus any vertical with an ACTIVE campaign — so
// launching a brewery campaign turns the brewery sweep on by itself.
async function activeVerticalIds() {
  const ids = await OutreachCampaign.distinct('vertical', { status: 'active' }).catch(() => []);
  const set = new Set([DEFAULT_VERTICAL_ID]);
  for (const id of ids) if (isVertical(id)) set.add(id);
  return [...set];
}

// In-process overlap guard, mirroring the outreach engine's `_ticking`: a forced
// "Refill now" sweep takes minutes (states × Overpass × site scrapes). If the 6h
// cron fires mid-run (or a second tab triggers another force), two invocations
// would sweep the same states in parallel — doubling the upstream load the
// per-run politeness cap exists to bound, writing duplicate run rows, and
// last-writer-wins clobbering the frontier. Only one sweep operation runs at a
// time (across all verticals — they sweep sequentially inside one tick).
let _sweeping = false;
async function withGuard(fn) {
  if (_sweeping) return { skipped: 'already-running' };
  _sweeping = true;
  try {
    return await fn();
  } finally {
    _sweeping = false;
  }
}

// Sweep ONE vertical. `force` bypasses the healthy-queue short-circuit (the
// Studio's "Refill now"), so a manual run always sweeps. `fromStart` rewinds that
// vertical's frontier to the first state — the "re-sweep the map" action for after
// the finder improves: imports dedupe on company + email, so a re-pass over
// already-swept states only ADDS shops the older pass missed.
async function _sweepVertical({ force = false, fromStart = false, vertical: verticalId = DEFAULT_VERTICAL_ID } = {}) {
  const v = getVertical(verticalId);
  const state = await getState(v.id);
  const available = await countAvailableColdLeads({ vertical: v.id });

  // The failure ledger is scoped to ONE finder version: a version bump means the
  // fetch/gate logic changed, so old failures (and old retry caps) no longer
  // describe this finder — wipe and start fresh.
  if ((Number(state.failedRegionsVersion) || 0) !== v.finderVersion) {
    state.failedRegions = {};
    state.failedRegionsVersion = v.finderVersion;
    state.markModified('failedRegions');
  }

  // ── Healthy pool: nothing to refill. But keep coverage FRESH on its own ──────
  // If the finder improved since some states were last swept, quietly re-milk a
  // bounded few (oldest-swept first) so a better finder retroactively upgrades
  // states it already touched — the owner never has to press "re-sweep". A
  // forced run skips this and goes straight to a real refill sweep below.
  if (available >= LOW_WATERMARK && !force) {
    const stale = await staleRegions(v.finderVersion, MAX_UPGRADE_PER_RUN, v.id);
    if (!stale.length) {
      state.lastRunAt = new Date();
      state.lastResult = `queue healthy — ${available} cold ${v.short} ready to enroll; coverage current`;
      await state.save();
      return { vertical: v.id, skipped: 'queue-healthy', available };
    }
    const swept = [];
    let upgraded = 0;
    let lastError = '';
    for (const region of stale) {
      try {
        const r = await runFinder({ region, vertical: v.id, dryRun: false });
        upgraded += r.created || 0;
        swept.push(`${r.label} +${r.created}`);
        clearRegionFailure(state, region);
      } catch (err) {
        lastError = err.message;
        swept.push(`${REGIONS[region] ? REGIONS[region].label : region} (error)`);
        // Honest coverage + retry-first next sweep (same ledger the frontier uses).
        await noteRegionFailure(state, region, v.id, err);
      }
    }
    // An upgrade pass does NOT advance the frontier — it re-milks in place.
    state.lastRunAt = new Date();
    state.lastResult = `coverage upgrade — re-milked ${stale.length} state(s) on the improved finder (${swept.join(', ')})${lastError ? ` — last error: ${lastError}` : ''}`;
    await state.save();
    return { vertical: v.id, upgrade: true, available, regionsSwept: stale.length, upgraded, swept };
  }

  // ── Low pool (or forced): expand the frontier until it's topped back up ──────
  let frontier = fromStart ? DEFAULT_REGION
    : (isRegion(state.activeRegion) ? state.activeRegion : DEFAULT_REGION);
  if (fromStart) state.dryStreak = 0;
  // ERRORED states first: a state whose last sweep THREW was never actually
  // covered — retrying it beats advancing into fresh ground (otherwise one
  // Overpass hiccup silently drops NY/CA until the frontier wraps the country).
  // Bounded by the same states-per-run politeness cap; capped attempts per
  // finder version so a broken region eventually parks instead of looping.
  const retryQueue = retryableFailedRegions(state.failedRegions);
  let importedTotal = 0;
  let regionsSwept = 0;
  const swept = [];
  let lastError = '';
  while (importedTotal < REFILL_TARGET && regionsSwept < MAX_REGIONS_PER_RUN) {
    const fromRetry = retryQueue.length > 0;
    const region = fromRetry ? retryQueue.shift() : frontier;
    try {
      const result = await runFinder({ region, vertical: v.id, dryRun: false });
      importedTotal += result.created || 0;
      swept.push(`${result.label} +${result.created}`);
      clearRegionFailure(state, region);
    } catch (err) {
      lastError = err.message;
      swept.push(`${REGIONS[region] ? REGIONS[region].label : region} (error)`);
      // Record the failure (audit row + retry ledger) — but still move on below:
      // one bad state must not wedge THIS run; the ledger retries it NEXT run.
      await noteRegionFailure(state, region, v.id, err);
    }
    // Retries live BEHIND the frontier — only a frontier sweep advances it (a
    // retried state advancing the pointer would skip un-swept ground).
    if (!fromRetry) frontier = nextRegionAfter(region); // resume from the NEXT state next time
    regionsSwept += 1;
  }

  state.activeRegion = frontier;
  state.dryStreak = 0;
  state.lastRunAt = new Date();
  state.lastResult = importedTotal
    ? `refilled ${importedTotal} new ${v.short} across ${regionsSwept} states (${swept.join(', ')}) — ${available} were left`
    : `swept ${regionsSwept} states, 0 new ${v.short}${lastError ? ` — last error: ${lastError}` : ' (OSM has no new shops there yet)'}`;
  await state.save();
  return { vertical: v.id, available, imported: importedTotal, regionsSwept, swept, nextRegion: frontier };
}

// Public single-vertical entry (the Studio "Refill now" + the launch kick). Guards
// against overlap. Defaults to dispensaries.
async function runFrontierSweep({ force = false, fromStart = false, vertical = DEFAULT_VERTICAL_ID } = {}) {
  return withGuard(() => _sweepVertical({ force, fromStart, vertical }));
}

// Sweep every ACTIVE vertical this tick (the cron path). One guard around the
// whole set so the verticals sweep sequentially, never in parallel.
async function runAllFrontierSweeps({ force = false } = {}) {
  return withGuard(async () => {
    const ids = await activeVerticalIds();
    const results = {};
    for (const id of ids) {
      try {
        results[id] = await _sweepVertical({ force, vertical: id });
      } catch (err) {
        results[id] = { vertical: id, error: err.message };
      }
    }
    return { verticals: ids, results };
  });
}

function startLeadFinderScheduler() {
  // Every 6 hours, always on. The tick self-gates on each vertical's queue depth,
  // so it's a cheap no-op when the pools are full — but it refills promptly
  // (within hours, not a week) once sending draws a pool down.
  cron.schedule('0 */6 * * *', () => {
    runAllFrontierSweeps({ force: false }).catch((e) => console.error('[lead-finder] sweep error:', e.message));
  });
  console.log(`[lead-finder] engine started — always on, queue-aware refill every 6h per active vertical (low<${LOW_WATERMARK}, target ${REFILL_TARGET} emailable, ≤${MAX_REGIONS_PER_RUN} states/run, ≤${MAX_UPGRADE_PER_RUN} auto-upgrades/run)`);
}

module.exports = {
  startLeadFinderScheduler, runFrontierSweep, runAllFrontierSweeps, activeVerticalIds, getState,
  retryableFailedRegions, // pure — unit-tested
};
