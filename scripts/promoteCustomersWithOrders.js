// scripts/promoteCustomersWithOrders.js
//
// ONE-TIME, MANUALLY-RUN reconciliation: a company with at least one linked
// Order is a CUSTOMER, never a "lead". Older imports (and early CRM records)
// may have left such companies sitting at 'lead' or 'contacted'. This scans
// every Client, and for any that has ≥1 Order but is still parked at lead/
// contacted, promotes its stage to 'customer'.
//
// It is NOT run on boot — run it by hand after a big import:
//   node scripts/promoteCustomersWithOrders.js            # apply changes
//   node scripts/promoteCustomersWithOrders.js --dry-run  # preview only, write nothing
//
// SAFETY / idempotency:
//   • Only promotes from 'lead' or 'contacted' (the import-default floor). It
//     NEVER touches 'quoting'/'sampling' (owner advanced them), 'won'/'lost'/
//     'dormant' (deliberate end states), or already-'customer' records — so a
//     deal the owner closed or parked is never resurrected/regressed.
//   • Skips archived (soft-deleted) records entirely.
//   • Re-running after it's done changes nothing (idempotent): once promoted, a
//     record is 'customer' and no longer matches the lead/contacted filter.
//   • Match is by companyKey (the SAME identity Orders use), so promotion lines
//     up exactly with real order history.

require('dotenv').config();
const mongoose = require('mongoose');
const Client = require('../models/Client');
const Order  = require('../models/Order');

// The only stages this script will promote FROM. Everything else is left alone.
const PROMOTABLE_FROM = ['lead', 'contacted'];

async function run() {
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');

  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set — aborting.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  // Candidates: non-archived Clients still at the import-default floor.
  const candidates = await Client.find({
    archived: { $ne: true },
    stage: { $in: PROMOTABLE_FROM },
  }).select('companyKey companyName clientName stage').lean();

  if (!candidates.length) {
    console.log('No lead/contacted records to check. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  // Which of those have ≥1 Order? One batched query keyed by companyKey.
  const keys = candidates.map((c) => c.companyKey);
  const orderRows = await Order.find({ companyKey: { $in: keys } }).select('companyKey').lean();
  const withOrders = new Set(orderRows.map((o) => o.companyKey));

  const toPromote = candidates.filter((c) => withOrders.has(c.companyKey));

  console.log(`Scanned ${candidates.length} lead/contacted record(s); ` +
    `${toPromote.length} have ≥1 order and will be promoted to 'customer'` +
    `${dryRun ? ' (DRY RUN — nothing written)' : ''}.`);

  for (const c of toPromote) {
    const name = c.companyName || c.clientName || c.companyKey;
    console.log(`  • ${name} [${c.companyKey}] : ${c.stage} → customer`);
  }

  if (!dryRun && toPromote.length) {
    const result = await Client.updateMany(
      // Re-assert the guard in the write filter so a concurrent edit that moved a
      // record off lead/contacted can't be clobbered by this batch.
      { companyKey: { $in: toPromote.map((c) => c.companyKey) }, stage: { $in: PROMOTABLE_FROM }, archived: { $ne: true } },
      { $set: { stage: 'customer' } },
    );
    const changed = result.modifiedCount != null ? result.modifiedCount : (result.nModified || 0);
    console.log(`Done. Promoted ${changed} record(s) to 'customer'.`);
  } else if (dryRun) {
    console.log('Dry run complete — no changes written.');
  } else {
    console.log('Nothing to promote.');
  }

  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
