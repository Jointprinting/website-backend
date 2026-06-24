// services/gdriveBackup.js
// Schedules a weekly push of the full site backup to Google Drive. Only does
// anything once the admin has connected Drive (and GDRIVE_* env vars are set);
// otherwise each run is a quiet no-op. Same node-cron pattern as ssAutoSync.js.
const cron = require('node-cron');
const gdrive = require('../controllers/gdrive');
const GoogleDriveAuth = require('../models/GoogleDriveAuth');

// Single-process re-entrancy guard. A weekly cron tick must not stack on top of
// a still-running push (a slow upload, or a manual "Back up now" the owner just
// clicked) and try to build/upload a second archive concurrently. This app runs
// on a single dyno, so an in-memory flag is sufficient; if it ever scales out,
// the right fix is a DB lock keyed on GoogleDriveAuth.
let running = false;

async function runWeeklyBackup() {
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
  console.log('[gdrive-backup] Starting weekly backup push…');
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
  // 03:30 every Sunday — after the nightly jobs, low-traffic window.
  cron.schedule('30 3 * * 0', () => { runWeeklyBackup().catch((e) => console.error('[gdrive-backup]', e)); });
  console.log('[gdrive-backup] Weekly Drive backup scheduled for Sun 03:30 server time.');
}

module.exports = { startGoogleDriveBackup, runWeeklyBackup };
