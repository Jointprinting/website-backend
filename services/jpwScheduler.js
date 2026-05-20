// services/jpwScheduler.js
//
// Nightly background jobs for the JPW recon engine. Two jobs:
//
//   03:00 daily  — re-score every lead. Cheap (pure JS on existing data).
//                  Catches scoring-formula tweaks, urgency/seasonality drift,
//                  and the per-day rollover of any time-sensitive logic.
//
//   03:30 Sundays — re-audit any lead whose website hasn't been audited in
//                   30 days. Concurrency 3, PageSpeed off, hard cap of 100
//                   per run so we never crater the outbound socket budget.
//
// Both jobs are no-ops when the DB has no leads. Each run stores its result
// to JpwSchedulerState so the dashboard can show "last run X ago".
//
// Scheduling pattern matches services/ssAutoSync.js — same node-cron dep.
// Mongo connects before this is called (server.js starts the scheduler on
// the 'open' event), so DB writes are safe.

const cron = require('node-cron');
const JpwLead = require('../models/JpwLead');
const JpwSchedulerState = require('../models/JpwSchedulerState');
const { scoreLead } = require('./jpwScoring');
const { auditLeadsConcurrent } = require('./jpwAuditor');
const { runSweep } = require('./jpwPlacesIngest');
const { SOUTH_JERSEY_TOWNS, CATEGORIES } = require('./jpwConstants');

const STALE_AUDIT_DAYS = parseInt(process.env.JPW_STALE_AUDIT_DAYS || '30', 10);
const BATCH_AUDIT_CAP  = parseInt(process.env.JPW_NIGHTLY_AUDIT_CAP || '100', 10);

async function recordRun(jobName, payload) {
  await JpwSchedulerState.findOneAndUpdate(
    { job: jobName },
    { $set: { job: jobName, ran_at: new Date(), ...payload } },
    { upsert: true, new: true }
  );
}

// ── Job 1: nightly re-score ──────────────────────────────────────────────
async function runRescoreAll() {
  const start = Date.now();
  let updated = 0;
  let total = 0;
  try {
    const leads = await JpwLead.find({});
    total = leads.length;
    for (const lead of leads) {
      lead.lead_score = scoreLead(lead.toObject());
      await lead.save();
      updated += 1;
    }
    const duration_ms = Date.now() - start;
    await recordRun('nightly_rescore', { total, updated, duration_ms, error: '' });
    console.log(`[jpw-scheduler] nightly_rescore: ${updated}/${total} in ${duration_ms}ms`);
  } catch (err) {
    await recordRun('nightly_rescore', { total, updated, error: err.message });
    console.error('[jpw-scheduler] nightly_rescore error:', err.message);
  }
}

// ── Job 2: weekly stale-audit refresh ────────────────────────────────────
async function runStaleAudit() {
  const start = Date.now();
  const cutoff = new Date(Date.now() - STALE_AUDIT_DAYS * 86400000);
  let audited = 0;
  let attempted = 0;
  try {
    const leads = await JpwLead.find({
      website_url: { $ne: '' },
      $or: [
        { 'website_audit.audited_at': { $exists: false } },
        { 'website_audit.audited_at': null },
        { 'website_audit.audited_at': { $lt: cutoff } },
      ],
    }).limit(BATCH_AUDIT_CAP);
    attempted = leads.length;
    if (!attempted) {
      await recordRun('weekly_stale_audit', { attempted: 0, audited: 0, duration_ms: Date.now() - start, error: '' });
      return;
    }
    const results = await auditLeadsConcurrent(leads, {
      concurrency: 3,
      cityHints: SOUTH_JERSEY_TOWNS,
      usePageSpeed: false,
    });
    for (const { lead, audit, error } of results) {
      if (error || !audit) continue;
      lead.website_audit = audit;
      lead.lead_score = scoreLead(lead.toObject());
      try { await lead.save(); audited += 1; } catch (e) {
        console.error('[jpw-scheduler] stale_audit save:', e.message);
      }
    }
    const duration_ms = Date.now() - start;
    await recordRun('weekly_stale_audit', { attempted, audited, duration_ms, error: '' });
    console.log(`[jpw-scheduler] weekly_stale_audit: ${audited}/${attempted} in ${duration_ms}ms`);
  } catch (err) {
    await recordRun('weekly_stale_audit', { attempted, audited, error: err.message });
    console.error('[jpw-scheduler] weekly_stale_audit error:', err.message);
  }
}

// ── Job 3: weekly sweep (opt-in) ─────────────────────────────────────────
//
// Runs a 30-search-cap sweep across (all high-ticket categories × all SJ
// towns). Off by default because it consumes API quota; enable with
// JPW_WEEKLY_SWEEP_ENABLED=true. The runSweep helper enforces the daily
// cap regardless, so even with a high JPW_WEEKLY_SWEEP_MAX we won't blow
// the budget.
async function runWeeklySweep() {
  const start = Date.now();
  const max = parseInt(process.env.JPW_WEEKLY_SWEEP_MAX || '30', 10);
  try {
    const cats = CATEGORIES.filter((c) => c.tier === 'high').map((c) => c.name);
    const pairs = [];
    for (const cat of cats) {
      for (const town of SOUTH_JERSEY_TOWNS) pairs.push({ category: cat, town });
    }
    const result = await runSweep({ pairs, maxSearches: max });
    const duration_ms = Date.now() - start;
    await recordRun('weekly_sweep', {
      attempted: result.searches_run,
      audited: result.total_created,
      duration_ms,
      error: result.halted_reason || '',
    });
    console.log(`[jpw-scheduler] weekly_sweep: ${result.searches_run} searches, ${result.total_created} new leads in ${duration_ms}ms`);
  } catch (err) {
    await recordRun('weekly_sweep', { error: err.message });
    console.error('[jpw-scheduler] weekly_sweep error:', err.message);
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────
function startJpwScheduler() {
  // 03:00 every day
  cron.schedule('0 3 * * *', () => { runRescoreAll(); });
  // 03:30 on Sundays
  cron.schedule('30 3 * * 0', () => { runStaleAudit(); });
  // Mon 04:00 — opt-in weekly sweep, off unless env flag set
  if (process.env.JPW_WEEKLY_SWEEP_ENABLED === 'true') {
    cron.schedule('0 4 * * 1', () => { runWeeklySweep(); });
    console.log('[jpw-scheduler] started — rescore 03:00 daily, stale-audit 03:30 Sun, weekly-sweep 04:00 Mon');
  } else {
    console.log('[jpw-scheduler] started — rescore 03:00 daily, stale-audit 03:30 Sun (weekly-sweep off; set JPW_WEEKLY_SWEEP_ENABLED=true to enable)');
  }
}

module.exports = {
  startJpwScheduler,
  runRescoreAll,
  runStaleAudit,
  runWeeklySweep,
};
