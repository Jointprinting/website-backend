// controllers/promoProducts.js
//
// The promo catalog API (models/PromoProduct) — the data behind the Quoter's
// promo picker. Owner-only. Three doors:
//   GET  /api/promo-products          — list/search (the picker's feed)
//   POST /api/promo-products/import   — bulk upsert (a fresh catalog scrape)
//   PATCH /api/promo-products/:id     — archive/unarchive (house rule: no deletes)
// Plus seedPromoCatalog(), the boot-time loader for the repo's committed
// data/promoCatalog.json — the zero-friction path: owner hands over a new
// vendor PDF → it's scraped into that file → next deploy upserts it.

const fs = require('fs');
const path = require('path');
const PromoProduct = require('../models/PromoProduct');
const { normalizePromoProduct } = require('../services/promoCatalog');

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// GET /api/promo-products?q=&category=&includeArchived=
// Full docs (the picker needs every break); category rollup rides along so the
// UI can build its filter without a second call.
async function listPromoProducts(req, res) {
  try {
    const { q, category, includeArchived } = req.query;
    const cond = includeArchived === 'true' ? {} : { archived: { $ne: true } };
    if (category) cond.category = category;
    if (q) {
      const rx = new RegExp(escapeRegex(q), 'i');
      cond.$or = [{ name: rx }, { sku: rx }, { category: rx }, { description: rx }];
    }
    const products = await PromoProduct.find(cond).sort({ category: 1, name: 1 }).limit(500).lean();
    const categories = await PromoProduct.distinct('category', { archived: { $ne: true } });
    res.json({ products, categories: categories.filter(Boolean).sort(), count: products.length });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// Upsert one normalized product by its identity (sku+variant, name as the
// fallback for sku-less rows). $set only the fields this import carries, so a
// client-price-only import can never blank out stored net costs (and vice
// versa). Returns 'created' | 'updated'.
async function upsertOne(p, source) {
  const key = p.sku
    ? { sku: p.sku, variant: p.variant }
    : { name: p.name, variant: p.variant };
  const set = { ...p, source: source || '' };
  if (!p.clientPriceBreaks.length) delete set.clientPriceBreaks;
  if (!p.netCostBreaks.length) delete set.netCostBreaks;
  if (!p.setupCostClient) delete set.setupCostClient;
  if (!p.setupCostNet) delete set.setupCostNet;
  const r = await PromoProduct.updateOne(key, { $set: set }, { upsert: true });
  return r.upsertedCount ? 'created' : 'updated';
}

// POST /api/promo-products/import — { products: [...], source }
async function importPromoCatalog(req, res) {
  try {
    const body = req.body || {};
    const raws = Array.isArray(body.products) ? body.products : [];
    if (!raws.length) return res.status(400).json({ message: 'No products provided.' });
    const source = String(body.source || `import-${new Date().toISOString().slice(0, 10)}`);
    let created = 0; let updated = 0; let skipped = 0;
    for (const raw of raws) {
      const p = normalizePromoProduct(raw);
      if (!p) { skipped += 1; continue; }
      (await upsertOne(p, source)) === 'created' ? created += 1 : updated += 1;
    }
    res.json({ ok: true, created, updated, skipped });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// PATCH /api/promo-products/:id — archive/unarchive (+ light field edits).
async function patchPromoProduct(req, res) {
  try {
    const b = req.body || {};
    const set = {};
    if (b.archived !== undefined) {
      set.archived = b.archived === true;
      set.archivedAt = set.archived ? new Date() : null;
    }
    for (const f of ['name', 'category', 'description', 'turnaround']) {
      if (b[f] !== undefined) set[f] = String(b[f] || '');
    }
    if (!Object.keys(set).length) return res.status(400).json({ message: 'Nothing to update.' });
    const doc = await PromoProduct.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json({ product: doc });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// Boot-time seed from the repo's committed catalog file. Idempotent upserts;
// the caller (server.js) flag-guards it per data version so it runs once per
// drop. A new vendor PDF = new JSON in data/ + a bumped flag.
async function seedPromoCatalog() {
  const file = path.join(__dirname, '..', 'data', 'promoCatalog.json');
  if (!fs.existsSync(file)) return { seeded: 0, missing: true };
  const raws = JSON.parse(fs.readFileSync(file, 'utf8'));
  let seeded = 0;
  for (const raw of Array.isArray(raws) ? raws : []) {
    const p = normalizePromoProduct(raw);
    if (!p) continue;
    await upsertOne(p, 'catalog-2026-07');
    seeded += 1;
  }
  return { seeded };
}

module.exports = { listPromoProducts, importPromoCatalog, patchPromoProduct, seedPromoCatalog };
