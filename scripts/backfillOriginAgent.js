// scripts/backfillOriginAgent.js
//
// One-off: stamp `originAgentId` on every Client and Order written before the
// field existed.
//
// WHY IT MATTERS: `agentId` is who works a record NOW and moves when a book is
// reassigned; `originAgentId` is who SOURCED it and never moves. Commission is
// computed off origin. A row with no origin would read as owner-sourced, so an
// agent's own historical leads would silently drop to the house rate the first
// time the owner reassigned anything. Backfilling origin := current owner is
// correct precisely because nothing has been reassigned yet — today the two are
// the same by definition.
//
// SAFE: only touches rows where originAgentId is missing or null. Never
// overwrites a value that is already set, so re-running is a no-op. Pass
// --dry to count without writing.
//
//   node scripts/backfillOriginAgent.js --dry
//   node scripts/backfillOriginAgent.js

require('dotenv').config();
const mongoose = require('mongoose');

const Client = require('../models/Client');
const Order = require('../models/Order');

const DRY = process.argv.includes('--dry');

// Rows written before the field existed have it missing entirely; a defensive
// `null` arm covers anything a partial write left behind. An empty string is a
// REAL value (owner-sourced) and is deliberately not matched — re-running must
// not churn rows it already handled.
const NEEDS_BACKFILL = { $or: [{ originAgentId: { $exists: false } }, { originAgentId: null }] };

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('✖ No MONGODB_URI / MONGO_URI in env — refusing to guess a database.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(`✔ connected${DRY ? '  (DRY RUN — nothing will be written)' : ''}`);

  for (const [label, Model] of [['clients', Client], ['orders', Order]]) {
    const total = await Model.countDocuments(NEEDS_BACKFILL);
    if (!total) { console.log(`  ${label}: nothing to do`); continue; }

    if (DRY) {
      // Show the split so the run is predictable: how many will land as
      // owner-sourced ('') vs inherited from an agent's existing agentId.
      const agentOwned = await Model.countDocuments({
        ...NEEDS_BACKFILL, agentId: { $nin: ['', null] },
      });
      console.log(`  ${label}: ${total} to backfill — ${agentOwned} from an agent, ${total - agentOwned} owner-sourced`);
      continue;
    }

    // origin := whatever agentId currently says (missing agentId → ''), because
    // nothing has been reassigned yet. One pipeline update, no cursor.
    const r = await Model.updateMany(NEEDS_BACKFILL, [
      { $set: { originAgentId: { $ifNull: ['$agentId', ''] } } },
    ]);
    console.log(`  ${label}: backfilled ${r.modifiedCount}/${total}`);
  }

  await mongoose.disconnect();
  console.log('✔ done');
}

run().catch(async (e) => {
  console.error('✖ backfill failed:', e.message);
  try { await mongoose.disconnect(); } catch (_) { /* already down */ }
  process.exit(1);
});
