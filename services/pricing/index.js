// Printer pricing: seed registry + bootstrap. Add a printer here once its
// matrix is transcribed under ./seeds and it loads automatically on deploy.

const PrinterRateCard = require('../../models/PrinterRateCard');
const { lookupPrice } = require('../pricingEngine');

const SEEDS = [
  require('./seeds/heritage'),
];

// Insert-if-missing: bootstraps each printer's rate card on first boot WITHOUT
// ever overwriting admin edits already in the DB. Idempotent and best-effort.
async function ensureSeeded() {
  for (const seed of SEEDS) {
    try {
      const exists = await PrinterRateCard.exists({ printerName: seed.printerName });
      if (!exists) {
        await PrinterRateCard.create(seed);
        console.log(`[pricing] seeded rate card: ${seed.printerName}`);
      }
    } catch (e) {
      console.warn(`[pricing] seed failed for ${seed && seed.printerName}:`, e.message);
    }
  }
}

module.exports = { SEEDS, ensureSeeded, lookupPrice };
