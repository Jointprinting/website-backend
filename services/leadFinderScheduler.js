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
const { runFinder, countAvailableColdLeads } = require('./leadFinderRunner');
const { nextRegionAfter, isRegion, DEFAULT_REGION, REGIONS } = require('./dispensaryFinder');

// Refill when the enrollable-cold-lead pool drops below this…
const LOW_WATERMARK = parseInt(process.env.LEAD_FINDER_LOW_WATERMARK || '40', 10);
// …and keep sweeping states until we've added this many new leads…
const REFILL_TARGET = parseInt(process.env.LEAD_FINDER_REFILL_TARGET || '75', 10);
// …but never more than this many states in a single run (politeness cap).
const MAX_REGIONS_PER_RUN = parseInt(process.env.LEAD_FINDER_MAX_REGIONS || '6', 10);

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
async function runFrontierSweep({ force = false, fromStart = false } = {}) {
  const state = await getState();

  const available = await countAvailableColdLeads();
  if (available >= LOW_WATERMARK && !force) {
    state.lastRunAt = new Date();
    state.lastResult = `queue healthy — ${available} cold leads ready to enroll`;
    await state.save();
    return { skipped: 'queue-healthy', available };
  }

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
      importedTotal += result.created;
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
  console.log(`[lead-finder] engine started — always on, queue-aware refill every 6h (low<${LOW_WATERMARK}, target ${REFILL_TARGET}, ≤${MAX_REGIONS_PER_RUN} states/run)`);
}

module.exports = { startLeadFinderScheduler, runFrontierSweep, getState };
