// services/ssAutoSync.js
// Schedules a nightly price+size refresh for all S&S-sourced products.
// Only runs when SS_ACCOUNT and SS_API_KEY are configured.
const cron = require('node-cron');
const { _refreshAllSSProducts } = require('../controllers/product');

// Pinned to the BUSINESS timezone. Nothing pins TZ on the host, so an unpinned
// cron runs on whatever zone the platform hands us — UTC today — which makes
// "2am" mean 10pm ET, the owner's evening rather than overnight.
const CRON_TZ = { timezone: 'America/New_York' };

function startSSAutoSync() {
  // 2:00 AM ET every night
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
  }, CRON_TZ);

  console.log('[SS auto-sync] Nightly price refresh scheduled at 02:00 ET.');
}

module.exports = { startSSAutoSync };
