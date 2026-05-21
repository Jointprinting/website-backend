// services/ssWarmAll.js
//
// Background warm loop: walks every style across SS_POPULAR_BRANDS and syncs
// each into MongoDB with full color list, per-color images (compressed WebP
// in GridFS), real piece prices, and real size ranges. Once a style is in
// Mongo, the product detail page renders instantly with clickable color
// swatches that swap the hero image — no on-demand sync needed.
//
// Designed for Render's 512 MB free dyno:
//   - Serial (concurrency 1) so Sharp/WebP encoding peaks at ~30 MB per
//     style, then GCs before the next call.
//   - 500 ms delay between styles to avoid bursting S&S's rate limits.
//   - Skips styles already synced within the last 7 days.
//   - Per-style failures (e.g. fetchSSProducts can't find matching SKUs)
//     are logged and skipped — the loop never aborts.

const Product = require('../models/Product');

const FRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000; // skip styles synced in last 7d

let _running = false;

async function warmAllStyles() {
  if (_running) {
    console.log('[warmAll] already running — ignoring duplicate trigger.');
    return;
  }
  _running = true;
  const startedAt = Date.now();

  // Pulled lazily to avoid a require-cycle with controllers/product.js
  const ctl = require('../controllers/product');
  if (!process.env.SS_ACCOUNT || !process.env.SS_API_KEY) {
    console.log('[warmAll] S&S credentials missing — skipping.');
    _running = false;
    return;
  }

  console.log('[warmAll] starting full S&S catalog warm — gathering style list…');

  // Get every style across the popular brands. fetchSSBrandStyles is the
  // existing fetchAndGroupSSBrand which caches per-brand for 4 hours, so this
  // is cheap if the catalog has been browsed recently.
  const brands = ctl._getSSPopularBrands();
  const allStyles = [];
  const seen = new Set();

  for (const brand of brands) {
    try {
      const { styles } = await ctl._fetchSSBrandStyles(brand);
      for (const s of styles) {
        if (s.style && !seen.has(s.style)) {
          seen.add(s.style);
          allStyles.push(s.style);
        }
      }
    } catch (e) {
      console.warn(`[warmAll] couldn't list brand "${brand}": ${e.message}`);
    }
    // Brief pause between brand fetches so we don't burst.
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log(`[warmAll] ${allStyles.length} unique styles to consider.`);

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  const freshCutoff = new Date(Date.now() - FRESH_TTL_MS);

  for (let i = 0; i < allStyles.length; i++) {
    const styleName = allStyles[i];

    try {
      const existing = await Product.findOne({ style: styleName })
        .select('updatedAt source')
        .lean();
      if (existing && existing.source === 'ssactivewear' && existing.updatedAt > freshCutoff) {
        skipped++;
      } else {
        await ctl.syncSingleStyleDeduped(styleName);
        synced++;
      }
    } catch (e) {
      failed++;
      console.warn(`[warmAll] skipped "${styleName}": ${e.message}`);
    }

    // Progress log every 50 styles.
    if ((i + 1) % 50 === 0) {
      const pct = Math.round(((i + 1) / allStyles.length) * 100);
      console.log(`[warmAll] ${i + 1}/${allStyles.length} processed (${pct}%) — synced ${synced}, skipped ${skipped}, failed ${failed}`);
    }

    // Serial pacing: 500 ms between styles keeps memory + S&S rate steady.
    await new Promise((r) => setTimeout(r, 500));
  }

  const elapsedMin = Math.round((Date.now() - startedAt) / 60_000);
  console.log(`[warmAll] DONE in ${elapsedMin} min — synced ${synced}, skipped ${skipped}, failed ${failed}.`);
  _running = false;
}

module.exports = { warmAllStyles };
