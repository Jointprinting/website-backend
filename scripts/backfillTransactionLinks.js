// scripts/backfillTransactionLinks.js
//
// Manual runner for the SAME idempotent transaction-link backfill the server
// now performs on every boot (controllers/finances.backfillTransactionLinks):
// fill projectNumber + vendorId on legacy ledger rows, blanks only, ambiguity-
// safe. Useful for a one-off run against a database the API isn't booted on.
//
//   node scripts/backfillTransactionLinks.js
//
// (No --dry-run: the fill is blanks-only and repeat-safe; the boot hook runs
// the identical logic on every deploy anyway.)

require('dotenv').config();
const mongoose = require('mongoose');
const { backfillTransactionLinks } = require('../controllers/finances');

async function main() {
  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set — aborting.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);
  const r = await backfillTransactionLinks();
  console.log(`scanned ${r.scanned} unlinked transaction(s)`);
  console.log(`linked ${r.projFilled} row(s) to projects, ${r.vendorFilled} to vendors`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
