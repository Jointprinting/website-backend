// scripts/backfillVendorKeys.js
//
// ONE-TIME, MANUALLY-RUN migration for VENDOR IDENTITY.
//
// Vendors and POs are now keyed on a canonical `vendorKey` (utils/poCost.vendorKey
// — trim + collapse internal whitespace + lowercase), the same key POs were
// already GROUPED and NUMBERED on, now persisted and indexed. Lookups used to
// match on a case-insensitive regex built from the raw name, and the ~5 sites
// that did it disagreed about whitespace: some collapsed runs of spaces, some
// didn't. So "Heritage  Printing" could fail to find "Heritage Printing" and
// quietly mint a SECOND vendor record with its own PO numbering sequence.
//
// New writes derive the key automatically (model hooks on save and
// findOneAndUpdate alike). This stamps the documents that already exist.
//
//   node scripts/backfillVendorKeys.js            # apply
//   node scripts/backfillVendorKeys.js --dry-run  # preview only
//
// SAFETY / idempotency:
//   • Derives ONLY from each document's own name — no merging, no renaming,
//     nothing deleted. A vendor's name is never touched.
//   • Re-running changes nothing: a doc with a correct key no longer matches.
//   • Reads are unaffected while it runs. Every lookup already falls back to the
//     old name match for documents whose vendorKey is still empty, so a partial
//     or interrupted run cannot make a real vendor invisible.
//   • ARCHIVED records are backfilled too — the dedup/merge tooling reads them,
//     and an un-keyed archived row would look like a different vendor.
//
// It also REPORTS (never auto-fixes) any groups of live vendors that collapse to
// the same key. Those are the forks this bug produced; merging them is an owner
// decision through the existing dedup tool, not something a migration should do
// behind his back.

require('dotenv').config();
const mongoose = require('mongoose');

const Vendor = require('../models/Vendor');
const PurchaseOrder = require('../models/PurchaseOrder');
const { vendorKey } = require('../utils/poCost');

const dryRun = process.argv.includes('--dry-run');

// Docs whose stored key doesn't yet exist. (A doc whose key is present but stale
// can't happen — the hooks keep it in step — but recomputing is harmless.)
const NEEDS_KEY = { $or: [{ vendorKey: { $exists: false } }, { vendorKey: '' }, { vendorKey: null }] };

async function backfill(Model, nameField, label) {
  const docs = await Model.find(NEEDS_KEY).select(`_id ${nameField}`).lean();
  const withName = docs.filter((d) => vendorKey(d[nameField]));
  const blank = docs.length - withName.length;

  console.log(`${label}: ${docs.length} without a key` +
    `${blank ? ` (${blank} have no ${nameField} at all — skipped)` : ''}` +
    `${dryRun ? ' — DRY RUN, nothing written' : ''}`);

  if (dryRun || !withName.length) return 0;

  const ops = withName.map((d) => ({
    updateOne: { filter: { _id: d._id }, update: { $set: { vendorKey: vendorKey(d[nameField]) } } },
  }));
  const res = await Model.bulkWrite(ops, { ordered: false });
  const changed = res.modifiedCount != null ? res.modifiedCount : 0;
  console.log(`  → keyed ${changed} ${label.toLowerCase()}`);
  return changed;
}

// Live vendors that now collapse to one key = the duplicate records the old
// regex lookups allowed. Reported for the owner, never merged here.
async function reportCollisions() {
  const live = await Vendor.find({ archived: { $ne: true } }).select('name').lean();
  const byKey = new Map();
  for (const v of live) {
    const k = vendorKey(v.name);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(v.name);
  }
  const forks = [...byKey.entries()].filter(([, names]) => names.length > 1);
  if (!forks.length) {
    console.log('\nNo duplicate vendor records — every live vendor has its own identity.');
    return;
  }
  console.log(`\n${forks.length} vendor name(s) resolve to the SAME printer — these are the forks:`);
  for (const [key, names] of forks) {
    console.log(`  ${key}`);
    for (const n of names) console.log(`    · ${JSON.stringify(n)}`);
  }
  console.log('\nNOT merged automatically — merging re-points POs, receipts and numbering,');
  console.log('so it stays an explicit, reversible action in the vendor dedup tool.');
}

async function run() {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set.');
  await mongoose.connect(process.env.MONGO_URI);

  await backfill(Vendor, 'name', 'Vendors');
  await backfill(PurchaseOrder, 'vendorName', 'Purchase orders');
  await reportCollisions();

  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
