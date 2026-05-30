// scripts/migrateImagesToR2.js
//
// One-time, idempotent migration: move base64 images that currently live inside
// MongoDB documents over to Cloudflare R2, replacing each value with its public
// URL. Run AFTER the R2_* env vars are set (locally or on Render):
//
//   node scripts/migrateImagesToR2.js     (or: npm run migrate-images-r2)
//
// Safe to run repeatedly — anything already a URL (or not base64) is skipped.
// Uses cursors so a large library doesn't exhaust memory on the Render box.

require('dotenv').config();
const mongoose = require('mongoose');
const r2 = require('../services/r2');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const Order = require('../models/Order');
const ClientLogo = require('../models/ClientLogo');

const isBase64 = (s) => typeof s === 'string' && s.startsWith('data:');

async function migrateStudio() {
  let moved = 0, scanned = 0;
  const cursor = StudioLibraryItem.find({}).cursor();
  for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
    scanned++;
    let dirty = false;
    if (isBase64(doc.thumbnail)) { doc.thumbnail = await r2.uploadDataUrl(doc.thumbnail, `${doc.store}/img`); dirty = true; moved++; }
    if (isBase64(doc.data))      { doc.data      = await r2.uploadDataUrl(doc.data,      `${doc.store}/img`); dirty = true; moved++; }
    if (dirty) await doc.save();
  }
  console.log(`[studio] scanned ${scanned} items, moved ${moved} images`);
}

async function migrateOrders() {
  let movedImgs = 0, ordersTouched = 0, scanned = 0;
  const cursor = Order.find({ 'confirmation.items.0': { $exists: true } }).cursor();
  for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
    scanned++;
    const items = (doc.confirmation && doc.confirmation.items) || [];
    let dirty = false;
    for (const it of items) {
      if (!it) continue;
      if (isBase64(it.customMockupDataUrl)) {
        it.customMockupDataUrl = await r2.uploadDataUrl(it.customMockupDataUrl, 'confirmations/img');
        dirty = true; movedImgs++;
      }
      for (const snap of (it.mockupSnapshots || [])) {
        if (snap && isBase64(snap.dataUrl)) {
          snap.dataUrl = await r2.uploadDataUrl(snap.dataUrl, 'confirmations/img');
          dirty = true; movedImgs++;
        }
      }
    }
    if (dirty) { doc.markModified('confirmation'); await doc.save(); ordersTouched++; }
  }
  console.log(`[orders] scanned ${scanned} orders, updated ${ordersTouched}, moved ${movedImgs} images`);
}

async function migrateLogos() {
  let moved = 0, scanned = 0;
  const cursor = ClientLogo.find({}).cursor();
  for (let doc = await cursor.next(); doc; doc = await cursor.next()) {
    scanned++;
    if (isBase64(doc.imageDataUrl)) {
      doc.imageDataUrl = await r2.uploadDataUrl(doc.imageDataUrl, 'logos/img');
      await doc.save();
      moved++;
    }
  }
  console.log(`[logos] scanned ${scanned} logos, moved ${moved} images`);
}

(async () => {
  if (!r2.isR2Configured()) { console.error('✗ R2 not configured — set the R2_* env vars first.'); process.exit(1); }
  if (!process.env.MONGO_URI) { console.error('✗ MONGO_URI not set.'); process.exit(1); }
  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB. Migrating images to R2…');
  try {
    await migrateStudio();
    await migrateOrders();
    await migrateLogos();
    console.log('✓ Migration complete.');
  } catch (e) {
    console.error('Migration error:', e);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
