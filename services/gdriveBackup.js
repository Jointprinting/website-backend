// services/gdriveBackup.js
// Schedules a weekly push of the full site backup to Google Drive. Only does
// anything once the admin has connected Drive (and GDRIVE_* env vars are set);
// otherwise each run is a quiet no-op. Same node-cron pattern as ssAutoSync.js.
const cron = require('node-cron');
const gdrive = require('../controllers/gdrive');
const GoogleDriveAuth = require('../models/GoogleDriveAuth');

function startGoogleDriveBackup() {
  // 03:30 every Sunday — after the nightly jobs, low-traffic window.
  cron.schedule('30 3 * * 0', async () => {
    if (!gdrive.isConfigured()) return;
    const auth = await GoogleDriveAuth.findOne();
    if (!auth || !auth.refreshToken) return;   // not connected — nothing to do
    console.log('[gdrive-backup] Starting weekly backup push…');
    try {
      const r = await gdrive.pushBackupToDrive('scheduled');
      console.log(`[gdrive-backup] Done — ${r.fileName} (${Math.round(r.sizeBytes / 1024)} KB).`);
    } catch (err) {
      console.error('[gdrive-backup] Failed:', err.message);
      try { auth.lastError = err.message; await auth.save(); } catch (_) {}
    }
  });
  console.log('[gdrive-backup] Weekly Drive backup scheduled for Sun 03:30 server time.');
}

module.exports = { startGoogleDriveBackup };
