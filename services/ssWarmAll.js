// services/ssWarmAll.js
//
// Background warm loop: walks every style across SS_POPULAR_BRANDS and
// upserts a MongoDB record for each via syncSingleStyleDeduped. Each
// record stores S&S CDN URLs (not GridFS blobs) so the whole catalog
// fits comfortably in free Mongo M0 (~50 MB total, vs ~5 GB if we
// stored images).
//
// Pacing: serial with 200 ms gap between styles. With image downloads
// removed, each sync is just one S&S /products/ call + one Mongo upsert,
// so a single style takes ~300-800 ms. Full catalog (~3,000 popular-brand
// styles) warms in roughly 30-60 minutes. Per-style failures are logged
// and the loop continues.

const Product = require('../models/Product');

const FRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PER_STYLE_PAUSE_MS = 200;
const PER_BRAND_PAUSE_MS = 500;

let _running = false;

async function warmAllStyles() {
  if (_running) {
    console.log('[warmAll] already running — ignoring duplicate trigger.');
    return;
  }
  _running = true;
  const startedAt = Date.now();

  const ctl = require('../controllers/product');
  if (!process.env.SS_ACCOUNT || !process.env.SS_API_KEY) {
    console.log('[warmAll] S&S credentials missing — skipping.');
    _running = false;
    return;
  }

  console.log('[warmAll] starting full S&S catalog warm — gathering style list…');

  const brands = ctl._getSSPopularBrands();
  const allStyles = [];   // [{ style, styleID }]
  const seen = new Set();

  for (const brand of brands) {
    try {
      const { styles } = await ctl._fetchSSBrandStyles(brand);
      for (const s of styles) {
        if (s.style && !seen.has(s.style)) {
          seen.add(s.style);
          allStyles.push({ style: s.style, styleID: s.styleID });
        }
      }
    } catch (e) {
      console.warn(`[warmAll] couldn't list brand "${brand}": ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, PER_BRAND_PAUSE_MS));
  }

  console.log(`[warmAll] ${allStyles.length} unique styles to consider.`);

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  const freshCutoff = new Date(Date.now() - FRESH_TTL_MS);

  for (let i = 0; i < allStyles.length; i++) {
    const { style, styleID } = allStyles[i];

    try {
      const existing = await Product.findOne({ style })
        .select('updatedAt source priceFrom')
        .lean();
      // Skip if synced recently AND has a real priceFrom (not just placeholder)
      if (
        existing &&
        existing.source === 'ssactivewear' &&
        existing.updatedAt > freshCutoff &&
        existing.priceFrom != null
      ) {
        skipped++;
      } else {
        await ctl.syncSingleStyleDeduped(style, { styleID });
        synced++;
      }
    } catch (e) {
      failed++;
      console.warn(`[warmAll] skipped "${style}": ${e.message}`);
    }

    if ((i + 1) % 50 === 0) {
      const pct = Math.round(((i + 1) / allStyles.length) * 100);
      console.log(
        `[warmAll] ${i + 1}/${allStyles.length} processed (${pct}%) — synced ${synced}, skipped ${skipped}, failed ${failed}`
      );
    }

    await new Promise((r) => setTimeout(r, PER_STYLE_PAUSE_MS));
  }

  const elapsedMin = Math.round((Date.now() - startedAt) / 60_000);
  console.log(
    `[warmAll] DONE in ${elapsedMin} min — synced ${synced}, skipped ${skipped}, failed ${failed}.`
  );
  _running = false;
}

module.exports = { warmAllStyles };
