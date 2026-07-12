// controllers/promoCatalog.js
//
// The promo catalog: the owner's fixed-price promotional products (lighters,
// grinders, ashtrays…) that the Quoter pulls in as 0%-markup promo lines. Items
// are scanned out of a vendor promo-quote PDF (review-first — nothing saves until
// the owner confirms) or added by hand, then listed for the Quoter's picker.

const PromoCatalogItem = require('../models/PromoCatalogItem');
const scanner = require('../services/promoQuoteScanner');
const r2 = require('../services/r2');

const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? 0 : Number(v));

// Whitelist + coerce an incoming item. `partial` (for PUT) only touches the keys
// present in the body so a patch can't blank untouched fields.
function sanitize(raw, partial = false) {
  const o = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(raw, k);
  const s = (k) => String(raw[k] == null ? '' : raw[k]).trim();
  const setStr = (k, def = '') => { if (!partial || has(k)) o[k] = s(k) || def; };
  const setNum = (k) => { if (!partial || has(k)) o[k] = num(raw[k]); };
  setStr('name'); setStr('vendor'); setStr('sku'); setStr('description');
  setStr('category', 'Promo'); setStr('color'); setStr('unit', 'each'); setStr('notes');
  setStr('sourcePdfUrl'); setStr('sourceFileName'); setStr('confidence');
  setNum('price'); setNum('cost'); setNum('minQty');
  if (has('active')) o.active = !!raw.active;
  if (Array.isArray(raw.priceBreaks)) {
    o.priceBreaks = raw.priceBreaks.map((b) => ({ qty: num(b.qty), price: num(b.price), cost: num(b.cost) }));
  }
  return o;
}

// POST /api/promo-catalog/scan  (multipart: pdf) — parse the PDF and RETURN the
// items for the owner to review. Does NOT save anything to the catalog.
exports.scanPdf = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ message: 'Attach a PDF to scan.' });
    if (!scanner.isConfigured()) {
      return res.json({ configured: false, items: [], message: 'AI scanning is off (ANTHROPIC_API_KEY not set) — you can still add promo items by hand.' });
    }
    // Archive the original first (provenance), best-effort — a failed archive
    // must not block the scan.
    let sourcePdfUrl = '';
    try { if (r2.isR2Configured()) sourcePdfUrl = await r2.uploadBuffer(req.file.buffer, 'application/pdf', 'promo-quotes'); } catch (_) { /* non-fatal */ }

    const { data } = await scanner.scan(req.file.buffer, req.file.mimetype, req.file.originalname || '');
    const items = scanner.mapItems(data, { sourcePdfUrl, sourceFileName: req.file.originalname || '' });
    return res.json({
      configured: true,
      items,
      vendor: String(data.vendor || '').trim(),
      confidence: data.confidence || 'medium',
      flags: Array.isArray(data.flags) ? data.flags : [],
      sourcePdfUrl,
    });
  } catch (e) {
    // 200 with an error string so the tab can show it inline (mirrors receipts).
    return res.json({ configured: scanner.isConfigured(), items: [], error: e.message || 'Scan failed.' });
  }
};

// GET /api/promo-catalog?all=1 — list items (active only by default).
exports.list = async (req, res) => {
  try {
    const filter = req.query.all === '1' ? {} : { active: true };
    const items = await PromoCatalogItem.find(filter).sort({ category: 1, name: 1 }).lean();
    res.json(items);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// POST /api/promo-catalog — create one item or many. Body: { items: [...] } (from
// the review step) or a single item object.
exports.create = async (req, res) => {
  try {
    const body = req.body || {};
    const arr = Array.isArray(body.items) ? body.items : [body];
    const clean = arr.map((i) => sanitize(i)).filter((i) => i.name);
    if (!clean.length) return res.status(400).json({ message: 'No valid items to add — each needs a name.' });
    const created = await PromoCatalogItem.insertMany(clean);
    res.status(201).json(created);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// PUT /api/promo-catalog/:id — edit one item.
exports.update = async (req, res) => {
  try {
    const patch = sanitize(req.body || {}, true);
    const item = await PromoCatalogItem.findByIdAndUpdate(req.params.id, patch, { new: true });
    if (!item) return res.status(404).json({ message: 'Item not found.' });
    res.json(item);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// DELETE /api/promo-catalog/:id
exports.remove = async (req, res) => {
  try {
    const r = await PromoCatalogItem.findByIdAndDelete(req.params.id);
    if (!r) return res.status(404).json({ message: 'Item not found.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ message: e.message }); }
};
