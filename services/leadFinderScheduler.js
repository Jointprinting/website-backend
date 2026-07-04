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
// Free ($0 — OSM + own-site scraping). ALWAYS ON — there is no toggle. The
// owner wants leads to stack up behind the scenes without operating anything;
// the queue-aware gate above is the only throttle. Pattern mirrors
// services/jpwScheduler.js.

const cron = require('node-cron');
const LeadFinderState = require('../models/LeadFinderState');
const { runFinder, countAvailableColdLeads, staleRegions } = require('./leadFinderRunner');
const { nextRegionAfter, isRegion, DEFAULT_REGION, REGIONS, FINDER_VERSION } = require('./dispensaryFinder');

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

// Get-or-create the singleton frontier state.
async function getState() {
  return LeadFinderState.findOneAndUpdate(
    { key: 'frontier' },
    { $setOnInsert: { key: 'frontier', activeRegion: DEFAULT_REGION } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

// One lead-engine tick. Queue-aware: no-op when the cold-lead pool is healthy;
// otherwise sweeps successive states until the pool is refilled (or the per-run
// cap is hit). `force` bypasses the healthy-queue short-circuit (the Studio's
// "Refill now" button), so a manual run always sweeps. `fromStart` rewinds the
// frontier to the first state before sweeping — the "re-sweep the map" action
// for after the finder itself improves: imports dedupe on company + email, so a
// re-pass over already-swept states only ADDS shops the older pass missed.
// In-process overlap guard, mirroring the outreach engine's `_ticking`: a forced
// "Refill now" sweep takes minutes (states × Overpass × site scrapes). If the 6h
// cron fires mid-run (or a second tab triggers another force), two invocations
// would sweep the same states in parallel — doubling the upstream load the
// per-run politeness cap exists to bound, writing duplicate run rows, and
// last-writer-wins clobbering the frontier. Only one sweep runs at a time.
let _sweeping = false;

async function runFrontierSweep({ force = false, fromStart = false } = {}) {
  if (_sweeping) return { skipped: 'already-running' };
  _sweeping = true;
  try {
    return await _runFrontierSweep({ force, fromStart });
  } finally {
    _sweeping = false;
  }
}

async function _runFrontierSweep({ force = false, fromStart = false } = {}) {
  const state = await getState();

  const available = await countAvailableColdLeads();

  // ── Healthy pool: nothing to refill. But keep coverage FRESH on its own ──────
  // If the finder improved since some states were last swept, quietly re-milk a
  // bounded few (oldest-swept first) so a better finder retroactively upgrades
  // states it already touched — the owner never has to press "re-sweep". A
  // forced run skips this and goes straight to a real refill sweep below.
  if (available >= LOW_WATERMARK && !force) {
    const stale = await staleRegions(FINDER_VERSION, MAX_UPGRADE_PER_RUN);
    if (!stale.length) {
      state.lastRunAt = new Date();
      state.lastResult = `queue healthy — ${available} cold leads ready to enroll; coverage current`;
      await state.save();
      return { skipped: 'queue-healthy', available };
    }
    const swept = [];
    let upgraded = 0;
    let lastError = '';
    for (const region of stale) {
      try {
        const r = await runFinder({ region, dryRun: false });
        upgraded += r.created || 0;
        swept.push(`${r.label} +${r.created}`);
      } catch (err) {
        lastError = err.message;
        swept.push(`${REGIONS[region] ? REGIONS[region].label : region} (error)`);
      }
    }
    // An upgrade pass does NOT advance the frontier — it re-milks in place.
    state.lastRunAt = new Date();
    state.lastResult = `coverage upgrade — re-milked ${stale.length} state(s) on the improved finder (${swept.join(', ')})${lastError ? ` — last error: ${lastError}` : ''}`;
    await state.save();
    return { upgrade: true, available, regionsSwept: stale.length, upgraded, swept };
  }

  // ── Low pool (or forced): expand the frontier until it's topped back up ──────
  let region = fromStart ? DEFAULT_REGION
    : (isRegion(state.activeRegion) ? state.activeRegion : DEFAULT_REGION);
  if (fromStart) state.dryStreak = 0;
  let importedTotal = 0;
  let regionsSwept = 0;
  const swept = [];
  let lastError = '';
  while (importedTotal < REFILL_TARGET && regionsSwept < MAX_REGIONS_PER_RUN) {
    try {
      const result = await runFinder({ region, dryRun: false });
      importedTotal += result.created || 0;
      swept.push(`${result.label} +${result.created}`);
    } catch (err) {
      lastError = err.message;
      swept.push(`${REGIONS[region] ? REGIONS[region].label : region} (error)`);
    }
    region = nextRegionAfter(region); // resume from the NEXT state next time
    regionsSwept += 1;
  }

  state.activeRegion = region;
  state.dryStreak = 0;
  state.lastRunAt = new Date();
  state.lastResult = importedTotal
    ? `refilled ${importedTotal} new across ${regionsSwept} states (${swept.join(', ')}) — ${available} were left`
    : `swept ${regionsSwept} states, 0 new${lastError ? ` — last error: ${lastError}` : ' (OSM has no new shops there yet)'}`;
  await state.save();
  return { available, imported: importedTotal, regionsSwept, swept, nextRegion: region };
}

function startLeadFinderScheduler() {
  // Every 6 hours, always on. The tick self-gates on queue depth, so it's a
  // cheap no-op when the pool is full — but it refills promptly (within hours,
  // not a week) once sending draws the pool down.
  cron.schedule('0 */6 * * *', () => {
    runFrontierSweep({ force: false }).catch((e) => console.error('[lead-finder] sweep error:', e.message));
  });
  console.log(`[lead-finder] engine started — always on, queue-aware refill every 6h (v${FINDER_VERSION}, low<${LOW_WATERMARK}, target ${REFILL_TARGET} emailable, ≤${MAX_REGIONS_PER_RUN} states/run, ≤${MAX_UPGRADE_PER_RUN} auto-upgrades/run)`);
}

module.exports = { startLeadFinderScheduler, runFrontierSweep, getState };
