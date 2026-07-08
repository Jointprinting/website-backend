// services/gdriveBackup.js
// Schedules a NIGHTLY push of the full site backup to Google Drive. Only does
// anything once the admin has connected Drive (and GDRIVE_* env vars are set);
// otherwise each run is a quiet no-op. Same node-cron pattern as ssAutoSync.js.
const cron = require('node-cron');
const gdrive = require('../controllers/gdrive');
const GoogleDriveAuth = require('../models/GoogleDriveAuth');

// Cadence. NIGHTLY by default (03:30 server time) — a solo operator capturing
// leads/visits all day on the road can't afford a weekly loss window; nightly
// keeps the worst-case data loss under a day. Override with GDRIVE_BACKUP_CRON
// (standard 5-field cron) if the owner ever wants a different rhythm.
const BACKUP_CRON = process.env.GDRIVE_BACKUP_CRON || '30 3 * * *';
// Human-readable mirror of BACKUP_CRON for the hub (gdrive status reads this so
// the displayed schedule and the actual cron can never drift apart).
const SCHEDULE_LABEL = process.env.GDRIVE_BACKUP_LABEL
  || (BACKUP_CRON === '30 3 * * *' ? 'Nightly · 03:30 (server time)' : `Custom · ${BACKUP_CRON}`);
// Days without a successful push before the hub flags backups as "stale" (i.e.
// probably silently stopped). Nightly cadence → 2 days is a missed-two-nights
// alarm, not a hair trigger. Env-overridable.
const STALE_DAYS = Math.max(1, parseInt(process.env.GDRIVE_BACKUP_STALE_DAYS, 10) || 2);

// Single-process re-entrancy guard. A cron tick must not stack on top of a
// still-running push (a slow upload, or a manual "Back up now" the owner just
// clicked) and try to build/upload a second archive concurrently. This app runs
// on a single dyno, so an in-memory flag is sufficient; if it ever scales out,
// the right fix is a DB lock keyed on GoogleDriveAuth.
let running = false;

async function runScheduledBackup() {
  // NEVER crash the server: every failure mode below is caught and logged.
  if (!gdrive.isConfigured()) return;                 // Drive env vars not set — stay inert
  let auth = null;
  try {
    auth = await GoogleDriveAuth.findOne();
  } catch (e) {
    console.warn('[gdrive-backup] could not read Drive auth:', e.message);
    return;
  }
  if (!auth || !auth.refreshToken) return;            // not connected — nothing to do

  if (running) {
    console.warn('[gdrive-backup] previous backup still running — skipping this tick.');
    return;
  }
  running = true;
  console.log('[gdrive-backup] Starting scheduled backup push…');
  try {
    const r = await gdrive.pushBackupToDrive('scheduled');
    console.log(`[gdrive-backup] Done — ${r.fileName} (${Math.round(r.sizeBytes / 1024)} KB).`);
  } catch (err) {
    console.error('[gdrive-backup] Failed:', err.message);
    try { auth.lastError = err.message; await auth.save(); } catch (_) {}
  } finally {
    running = false;
  }
}

function startGoogleDriveBackup() {
  cron.schedule(BACKUP_CRON, () => { runScheduledBackup().catch((e) => console.error('[gdrive-backup]', e)); });
  console.log(`[gdrive-backup] Drive backup scheduled: ${SCHEDULE_LABEL} (cron "${BACKUP_CRON}").`);
}

module.exports = {
  startGoogleDriveBackup,
  runScheduledBackup,
  // Back-compat alias — anything still calling the old name keeps working.
  runWeeklyBackup: runScheduledBackup,
  // Exposed so the hub's Drive status can display the real schedule and decide
  // when auto-backups look "stale" without duplicating these values.
  SCHEDULE_LABEL,
  STALE_DAYS,
  BACKUP_CRON,
};
