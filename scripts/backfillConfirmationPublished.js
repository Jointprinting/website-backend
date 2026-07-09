// scripts/backfillConfirmationPublished.js
//
// ONE-TIME, MANUALLY-RUN migration for the confirmation PUBLISH GATE.
//
// The client-facing page now only shows a confirmation once the owner has
// explicitly PUSHED it (confirmation.publishedAt is set). Confirmations built
// BEFORE this gate existed have no publishedAt — so without this backfill, a
// client currently mid-review would be bounced back to the "we're finalizing
// your order" waiting screen. This stamps every existing confirmation that has
// real content as already-published (using its own order date / last-updated
// time), so nothing in flight regresses. New confirmations start unpublished
// and require the owner's "Push to client" button — exactly as intended.
//
//   node scripts/backfillConfirmationPublished.js            # apply
//   node scripts/backfillConfirmationPublished.js --dry-run  # preview only
//
// SAFETY / idempotency:
//   • Only touches orders whose confirmation HAS content (items or customLines)
//     AND has no publishedAt yet. A fresh, empty confirmation is skipped, so a
//     draft the owner hasn't pushed is never marked live.
//   • Re-running changes nothing: once publishedAt is set, the doc no longer
//     matches the filter.
//   • Sets publishedAt to the confirmation's own orderDate (else updatedAt, else
//     now) — a truthful "this was live as of" timestamp, never a future date.
//   • Non-destructive: adds one field; touches nothing else. To reverse, unset
//     confirmation.publishedAt on the affected docs.

require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/Order');

// Orders with a confirmation that has real content but no publish stamp yet.
const FILTER = {
  $and: [
    { $or: [{ 'confirmation.items.0': { $exists: true } }, { 'confirmation.customLines.0': { $exists: true } }] },
    { $or: [{ 'confirmation.publishedAt': null }, { 'confirmation.publishedAt': { $exists: false } }] },
  ],
};

async function run() {
  const dryRun = process.argv.includes('--dry-run') || process.argv.includes('-n');

  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set — aborting.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGO_URI);

  const count = await Order.countDocuments(FILTER);
  console.log(`${count} existing confirmation(s) need a publishedAt backfill` +
    `${dryRun ? ' (DRY RUN — nothing written)' : ''}.`);

  if (!dryRun && count > 0) {
    // Pipeline update so publishedAt is set per-doc from that doc's own date:
    // confirmation.orderDate → updatedAt → now. Never a future timestamp.
    const result = await Order.updateMany(FILTER, [
      {
        $set: {
          'confirmation.publishedAt': {
            $ifNull: ['$confirmation.orderDate', { $ifNull: ['$updatedAt', '$$NOW'] }],
          },
        },
      },
    ]);
    const changed = result.modifiedCount != null ? result.modifiedCount : (result.nModified || 0);
    console.log(`Done. Backfilled ${changed} confirmation(s) as already-published.`);
  } else if (dryRun) {
    console.log('Dry run complete — no changes written.');
  } else {
    console.log('Nothing to backfill.');
  }

  await mongoose.disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
