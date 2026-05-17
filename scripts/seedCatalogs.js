// scripts/seedCatalogs.js
//
// One-time seed for the existing four catalogs. Downloads each PDF from your
// live site (or a local override) and inserts a Catalog document with the
// same styling that's currently hardcoded in the frontend.
//
// Usage:
//   1. Make sure your .env has MONGO_URI set (the same one server.js uses).
//   2. From the backend folder, run:
//        node scripts/seedCatalogs.js
//
// To re-run from scratch (deletes existing catalogs first):
//        node scripts/seedCatalogs.js --reset
//
// To pull from a different host (e.g. a staging deploy):
//        SITE_BASE_URL=https://staging.jointprinting.com node scripts/seedCatalogs.js

require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const Catalog = require('../models/Catalog');
require('../gridfs'); // wires gfs onto the connection
const { getGfs } = require('../gridfs');

const SITE_BASE_URL = process.env.SITE_BASE_URL || 'https://jointprinting.com';

// Mirrors the current hardcoded array in src/screens/Catalogs.js
const SEED_CATALOGS = [
  {
    title:       'Prototype → Production',
    description: 'Custom wood display plaques, 3D-printed mascots and tap handles, slate coasters and trays. Unique products for brands that want something nobody else has.',
    tags:        ['Wood', '3D Printing', 'Slate', 'Retail Display'],
    stylePreset: 'default',
    accentColor: '#2e7d32',
    emoji:       '🪵',
    pdfUrl:      `${SITE_BASE_URL}/catalogs/prototype-to-production.pdf`,
    pdfFileName: 'prototype-to-production.pdf',
    sortOrder:   0,
  },
  {
    title:       "USA's 250th Anniversary Promo Collection",
    description: "Patriotic promo products timed for America's 250th anniversary in 2026. Sunglasses, drinkware, bags, apparel, stickers, and more — all customizable.",
    tags:        ['Drinkware', 'Bags', 'Apparel', 'Promos'],
    stylePreset: 'patriotic',
    accentColor: '#B22234',
    emoji:       '🇺🇸',
    pdfUrl:      `${SITE_BASE_URL}/catalogs/usa-250-promos.pdf`,
    pdfFileName: 'usa-250-promos.pdf',
    sortOrder:   1,
  },
  {
    title:       'JP × Dispensary',
    description: 'Apparel and merch built specifically for cannabis dispensaries — branded tees, hoodies, headgear, and giveaway items. Staff uniforms to customer gifts.',
    tags:        ['Apparel', 'Dispensary', 'Staff Uniforms', 'Giveaways'],
    stylePreset: 'canopy',
    accentColor: '#1b5e20',
    emoji:       '🌿',
    pdfUrl:      `${SITE_BASE_URL}/catalogs/dispensary-catalog.pdf`,
    pdfFileName: 'dispensary-catalog.pdf',
    sortOrder:   2,
  },
  {
    title:       'Dispensary Promos',
    description: 'Promotional add-ons for dispensary retail — stickers, accessories, and branded items designed to drive loyalty and repeat visits.',
    tags:        ['Promos', 'Dispensary', 'Accessories'],
    stylePreset: 'canopy',
    accentColor: '#004d40',
    emoji:       '🎁',
    pdfUrl:      `${SITE_BASE_URL}/catalogs/dispo-promos.pdf`,
    pdfFileName: 'dispo-promos.pdf',
    sortOrder:   3,
  },
];

function uploadBufferToGridfs(buffer, filename, contentType) {
  return new Promise((resolve, reject) => {
    const gfs = getGfs();
    const up = gfs.openUploadStream(filename, { contentType });
    up.on('error', reject);
    up.on('finish', () => resolve(up.id));
    up.end(buffer);
  });
}

async function fetchPdf(url) {
  console.log(`  ↓ fetching ${url}`);
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 60_000,
    maxContentLength: 100 * 1024 * 1024,
  });
  return Buffer.from(res.data);
}

async function main() {
  const reset = process.argv.includes('--reset');

  if (!process.env.MONGO_URI) {
    console.error('MONGO_URI is not set. Add it to .env first.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log('Connected to MongoDB.');

  // Wait one tick so gridfs.js's `mongoose.connection.once("open")` handler
  // has time to initialize the bucket before we call getGfs().
  await new Promise((r) => setTimeout(r, 500));

  const existingCount = await Catalog.countDocuments({});
  if (existingCount > 0) {
    if (!reset) {
      console.log(`Found ${existingCount} existing catalog(s). Re-run with --reset to wipe and re-seed.`);
      await mongoose.disconnect();
      process.exit(0);
    }
    console.log(`--reset specified. Deleting ${existingCount} existing catalog(s)...`);
    // Also clean up the GridFS files they reference.
    const existing = await Catalog.find({}, { pdfFileId: 1 }).lean();
    const gfs = getGfs();
    for (const c of existing) {
      if (c.pdfFileId) {
        try {
          await gfs.delete(new mongoose.Types.ObjectId(c.pdfFileId));
        } catch (e) {
          // file already missing — fine
        }
      }
    }
    await Catalog.deleteMany({});
    console.log('Existing catalogs deleted.');
  }

  for (const entry of SEED_CATALOGS) {
    console.log(`\n→ ${entry.title}`);
    try {
      const buffer = await fetchPdf(entry.pdfUrl);
      const fileId = await uploadBufferToGridfs(buffer, entry.pdfFileName, 'application/pdf');
      const doc = await Catalog.create({
        title:       entry.title,
        description: entry.description,
        tags:        entry.tags,
        stylePreset: entry.stylePreset,
        accentColor: entry.accentColor,
        emoji:       entry.emoji,
        pdfFileId:   fileId,
        pdfFileName: entry.pdfFileName,
        pdfFileSize: buffer.length,
        sortOrder:   entry.sortOrder,
        isPublished: true,
      });
      console.log(`  ✓ created catalog ${doc._id} (PDF ${buffer.length} bytes)`);
    } catch (err) {
      console.error(`  ✗ failed: ${err.message}`);
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
