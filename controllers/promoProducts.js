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
const { estimateShipping, BILLED_BY } = require('../services/promoShipping');

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
  // A weight the owner measured (or the vendor published) outranks anything an
  // import carries, so a re-seed can never silently undo it. An import that
  // DOES carry a weight still wins over a stored estimate.
  if (set.unitWeightOz === undefined || !(Number(set.unitWeightOz) > 0)) {
    delete set.unitWeightOz;
    delete set.weightSource;
  }
  const protectedFields = ['unitWeightOz', 'weightSource'];
  if (protectedFields.some((f) => set[f] !== undefined)) {
    const existing = await PromoProduct.findOne(key).select('weightSource').lean();
    if (existing && (existing.weightSource === 'owner' || existing.weightSource === 'catalog')) {
      protectedFields.forEach((f) => delete set[f]);
    }
  }
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
    // Correcting a weight promotes it to 'owner', which outranks the estimate
    // and survives every future catalog re-seed. Clearing it (null/0) hands the
    // item back to the estimator.
    if (b.unitWeightOz !== undefined) {
      const w = Number(b.unitWeightOz);
      if (w > 0) { set.unitWeightOz = w; set.weightSource = 'owner'; }
      else { set.unitWeightOz = null; set.weightSource = ''; }
    }
    if (b.cartonPackQty !== undefined) {
      const c = Number(b.cartonPackQty);
      set.cartonPackQty = c > 0 ? Math.round(c) : null;
    }
    if (!Object.keys(set).length) return res.status(400).json({ message: 'Nothing to update.' });
    const doc = await PromoProduct.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json({ product: doc });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// POST /api/promo-products/shipping-estimate
//   { lines: [{ sku, variant, name, qty }], destState, pad }
// Ballpark freight for a set of promo quote lines, allocated back per line so
// the Quoter can autofill each line's own shippingCost. The Quoter sends what a
// promo line already carries (styleCode = sku, description = name), so no new
// identifier has to be threaded through the builder.
//
// Resolution order per line: sku+variant, then sku, then exact name. An
// unresolved line still returns, with resolved:false, so the UI can say which
// item it could not weigh instead of silently under-quoting the order.
async function estimateQuoteShipping(req, res) {
  try {
    const body = req.body || {};
    const raw = Array.isArray(body.lines) ? body.lines : [];
    if (!raw.length) return res.status(400).json({ message: 'No lines provided.' });

    const skus = raw.map((l) => String(l.sku || '').trim()).filter(Boolean);
    const names = raw.map((l) => String(l.name || '').trim()).filter(Boolean);
    const docs = await PromoProduct.find({
      $or: [{ sku: { $in: skus } }, { name: { $in: names } }],
    }).lean();

    const unresolved = [];
    const lines = raw.map((l) => {
      const sku = String(l.sku || '').trim();
      const variant = String(l.variant || '');
      const name = String(l.name || '').trim();
      const product =
        (sku && docs.find((d) => d.sku === sku && (d.variant || '') === variant)) ||
        (sku && docs.find((d) => d.sku === sku)) ||
        (name && docs.find((d) => d.name === name)) ||
        null;
      if (!product) unresolved.push(name || sku || '(unnamed)');
      return { product: product || {}, qty: Number(l.qty) || 0, resolved: !!product };
    });

    const estimate = estimateShipping({
      lines,
      destState: body.destState || '',
      pad: body.pad === undefined ? undefined : Number(body.pad),
      // Cannabis Promotions ships on THEIR account and invoices the freight
      // afterwards, so the owner's UPS incentive does not apply here.
      billedBy: BILLED_BY.VENDOR,
    });
    estimate.basis.push('Cannabis Promotions bills this freight, not UPS — send one of their freight invoices and this stops being an estimate.');
    estimate.perLine.forEach((p, i) => { p.resolved = lines[i].resolved; });
    if (unresolved.length) {
      estimate.unresolved = unresolved;
      estimate.basis.push(`Not in the promo catalog, so not weighed: ${unresolved.join(', ')}`);
    }
    res.json(estimate);
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

module.exports = {
  listPromoProducts, importPromoCatalog, patchPromoProduct,
  estimateQuoteShipping, seedPromoCatalog,
};
