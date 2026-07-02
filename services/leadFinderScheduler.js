// services/leadFinderScheduler.js
//
// The long-term, self-advancing lead machine. A weekly cron works the CURRENT
// frontier region (LeadFinderState.activeRegion) with the free finder, and when
// that region stops turning up NEW dispensaries it steps the frontier to the
// next state in dispensaryFinder.NATIONAL_ROLLOUT — NJ → NY → PA → … → CA → WA,
// wrapping at the end to periodically re-catch newly opened shops.
//
// This is the answer to "don't just re-sweep NJ forever": the frontier only
// moves on once a state is worked out, and never wastes effort re-scraping a
// state that's already dry. $0 (OSM + own-site scraping). Off until the owner
// flips autoAdvance on (from the Studio), so it never surprises them; the cron
// checks the flag each run. Pattern mirrors services/jpwScheduler.js.

const cron = require('node-cron');
const LeadFinderState = require('../models/LeadFinderState');
const { runFinder } = require('./leadFinderRunner');
const { decideFrontier, isRegion, DEFAULT_REGION, REGIONS } = require('./dispensaryFinder');

const ADVANCE_AFTER = parseInt(process.env.LEAD_FINDER_ADVANCE_AFTER || '2', 10);

// Get-or-create the singleton frontier state.
async function getState() {
  return LeadFinderState.findOneAndUpdate(
    { key: 'frontier' },
    { $setOnInsert: { key: 'frontier', activeRegion: DEFAULT_REGION } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
}

// One auto-pilot tick: sweep the active region, then advance the frontier if it's
// gone dry. Exported so the controller can offer a "run the auto-pilot now"
// button and tests can drive it. `force` bypasses the autoAdvance flag (manual
// trigger); the cron passes force=false so a disabled auto-pilot stays idle.
async function runFrontierSweep({ force = false } = {}) {
  const state = await getState();
  if (!state.autoAdvance && !force) return { skipped: 'auto-advance-off' };

  const region = isRegion(state.activeRegion) ? state.activeRegion : DEFAULT_REGION;
  let result;
  try {
    result = await runFinder({ region, dryRun: false });
  } catch (err) {
    state.lastRunAt = new Date();
    state.lastResult = `error: ${err.message}`;
    await state.save();
    return { region, error: err.message };
  }

  const decision = decideFrontier({ region, created: result.created, dryStreak: state.dryStreak, advanceAfter: ADVANCE_AFTER });
  state.activeRegion = decision.region;
  state.dryStreak = decision.dryStreak;
  state.lastRunAt = new Date();
  state.lastResult = decision.advanced
    ? `${REGIONS[region] ? REGIONS[region].label : region} worked out → advancing to ${REGIONS[decision.region] ? REGIONS[decision.region].label : decision.region}`
    : `${REGIONS[region] ? REGIONS[region].label : region}: +${result.created} new (${result.withEmail} w/email)`;
  await state.save();

  return { region, ...result, advanced: decision.advanced, nextRegion: decision.region };
}

function startLeadFinderScheduler() {
  // Monday 05:00 (server/UTC). The tick self-gates on the autoAdvance flag, so
  // this is a no-op until the owner turns the auto-pilot on.
  cron.schedule('0 5 * * 1', () => {
    runFrontierSweep({ force: false }).catch((e) => console.error('[lead-finder] weekly sweep error:', e.message));
  });
  console.log('[lead-finder] scheduler started — weekly frontier sweep Mon 05:00 (idle until auto-advance is enabled)');
}

module.exports = { startLeadFinderScheduler, runFrontierSweep, getState };
