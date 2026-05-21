#!/usr/bin/env node
// scripts/backfillCompanyKey.js
//
// One-time backfill: derive `companyKey` on every existing Order so the
// /api/orders/clients aggregation can group by it and stop creating phantom
// duplicates for "Acme Co" vs "Acme Co.".
//
//   Usage:  node scripts/backfillCompanyKey.js
//
// Safe to re-run; only writes when the derived key differs from what's there.

require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('../models/Order');
const { deriveCompanyKey } = require('../models/Order');

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI not set');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('Connected.');

  let total = 0, updated = 0;
  const cursor = Order.find({}).cursor();
  for await (const o of cursor) {
    total++;
    const key = deriveCompanyKey(o.companyName, o.clientName);
    if (key !== o.companyKey) {
      await Order.updateOne({ _id: o._id }, { $set: { companyKey: key } });
      updated++;
    }
  }
  console.log(`Done. Scanned ${total}, updated ${updated}.`);
  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
