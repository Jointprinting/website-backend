// services/ssAutoSync.js
// Schedules a nightly price+size refresh for all S&S-sourced products.
// Only runs when SS_ACCOUNT and SS_API_KEY are configured.
const cron = require('node-cron');
const { _refreshAllSSProducts } = require('../controllers/product');

function startSSAutoSync() {
  // 2:00 AM server time every night
  cron.schedule('0 2 * * *', async () => {
    console.log('[SS auto-sync] Starting nightly price refresh…');
    try {
      const { updated, total, failed } = await _refreshAllSSProducts();
      console.log(`[SS auto-sync] Done — ${updated}/${total} updated, ${failed.length} failed.`);
      if (failed.length) {
        failed.forEach((f) => console.warn(`  ⚠ ${f.style}: ${f.reason}`));
      }
    } catch (err) {
      console.error('[SS auto-sync] Fatal error:', err.message);
    }
  });

  console.log('[SS auto-sync] Nightly price refresh scheduled at 02:00 server time.');
}

module.exports = { startSSAutoSync };
