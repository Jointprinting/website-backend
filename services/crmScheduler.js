// services/crmScheduler.js
//
// Daily CRM self-cleaning cron. Right now it does one job the owner asked for: keep
// the "N cold-outreach prospects in your book" pile from ever building up, so he
// never has to click "Clear N" — the system removes dead cold leads itself.
//
// It auto-archives only the DEAD ones (opted-out/bounced, or stale with no reply);
// fresh, still-in-sequence prospects are left alone. Everything is soft/reversible
// (a reply auto-unarchives via warm-handoff), so this is safe to run unattended.
// Pattern mirrors services/jpwScheduler.js (node-cron, bootstrapped on db 'open').

const cron = require('node-cron');
const { autoArchiveDeadColdProspects } = require('../controllers/crm');

async function runColdCleanup() {
  try {
    const { archived, keys } = await autoArchiveDeadColdProspects();
    if (archived > 0) {
      console.log(`[crm-scheduler] cold-cleanup: auto-archived ${archived} dead cold prospect(s).`);
    }
    return { archived, keys };
  } catch (err) {
    console.error('[crm-scheduler] cold-cleanup error:', err.message);
    return { archived: 0, keys: [] };
  }
}

function startCrmScheduler() {
  // 04:15 every day — after the JPW rescore (03:00) and stale audit, before the day.
  cron.schedule('15 4 * * *', () => { runColdCleanup(); });
  // Also sweep once shortly after boot so a long-running pile clears without waiting
  // for the first nightly tick (deferred a bit so startup isn't slowed).
  setTimeout(() => { runColdCleanup(); }, 60 * 1000);
  console.log('[crm-scheduler] started — cold-prospect cleanup 04:15 daily (+ once ~1m after boot)');
}

module.exports = { startCrmScheduler, runColdCleanup };
