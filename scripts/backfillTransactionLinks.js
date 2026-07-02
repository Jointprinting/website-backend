// scripts/backfillTransactionLinks.js
//
// ONE-TIME, MANUALLY-RUN backfill for the two ecosystem links added to
// Transaction in the project-level-finance / ledger→Vendor work:
//
//   • projectNumber — denormalized from the Order matching the row's canonical
//     order # (the SAME collision-safe map /api/finances/by-order joins on), so
//     the per-project P&L covers historical rows, not just new ones.
//   • vendorId — for EXPENSE rows, resolve the free-text `party` to the Vendor
//     card with the SAME ambiguity-safe resolver the PO builder and the finance
//     create/update paths use (exact key match, then conservative fuzzy; NEVER
//     guesses when more than one vendor matches).
//
// It is NOT run on boot — run it by hand after deploying the schema change:
//   node scripts/backfillTransactionLinks.js --dry-run   # preview only, write nothing
//   node scripts/backfillTransactionLinks.js             # apply changes
//
// SAFETY / idempotency:
//   • Only FILLS blanks — a row that already carries a projectNumber or vendorId
//     is never touched, so re-running (or running after the app has been writing
//     the new fields) changes nothing.
//   • Ambiguity leaves the field empty rather than guessing (two orders sharing a
//     canonical number with different project #s; two vendors both matching a
//     party name).
//   • Archived vendors are excluded from resolution, mirroring the live path.

require('dotenv').config();
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const Order = require('../models/Order');
const Vendor = require('../models/Vendor');
const { projectNumberByOrderNumber, normalizeOrderNumber } = require('../controllers/finances');
const { resolveVendorFromList } = require('../utils/vendorMatch');

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set — aborting.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const orderDocs = await Order.find({ orderNumber: { $ne: '' } })
    .select('orderNumber projectNumber').lean();
  const projByOrder = projectNumberByOrderNumber(orderDocs);
  const vendors = await Vendor.find({ archived: { $ne: true } }).select('name').lean();

  const rows = await Transaction.find({})
    .select('type party orderNumber projectNumber vendorId').lean();

  let projFilled = 0;
  let vendorFilled = 0;
  let scanned = 0;
  const vendorCache = new Map(); // party (lowercased) → vendorId|null, so each name resolves once

  for (const t of rows) {
    scanned += 1;
    const set = {};

    if (!String(t.projectNumber || '').trim()) {
      const key = normalizeOrderNumber(t.orderNumber);
      const pn = key ? projByOrder[key] : '';
      if (pn) set.projectNumber = pn;
    }

    if (t.type === 'expense' && !t.vendorId && String(t.party || '').trim()) {
      const cacheKey = String(t.party).trim().toLowerCase();
      if (!vendorCache.has(cacheKey)) {
        const hit = resolveVendorFromList(t.party, vendors);
        vendorCache.set(cacheKey, hit ? hit._id : null);
      }
      const vid = vendorCache.get(cacheKey);
      if (vid) set.vendorId = vid;
    }

    if (Object.keys(set).length === 0) continue;
    if (set.projectNumber) projFilled += 1;
    if (set.vendorId) vendorFilled += 1;
    if (!DRY_RUN) {
      // eslint-disable-next-line no-await-in-loop
      await Transaction.updateOne({ _id: t._id }, { $set: set });
    }
  }

  console.log(`${DRY_RUN ? '[dry-run] ' : ''}scanned ${scanned} transactions`);
  console.log(`${DRY_RUN ? '[dry-run] would fill' : 'filled'} projectNumber on ${projFilled} rows`);
  console.log(`${DRY_RUN ? '[dry-run] would fill' : 'filled'} vendorId on ${vendorFilled} rows`);

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
