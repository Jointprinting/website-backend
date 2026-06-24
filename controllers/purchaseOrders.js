// controllers/purchaseOrders.js
//
// Purchase orders for printers/vendors — built per project, downloaded as a
// PDF the admin emails out himself. Mirrors the hand-made Google Docs POs:
// "{Vendor} x Joint Printing PO", header fields, shipping block, lettered
// product/print items, order summary charges, grand total. Vendors are
// remembered in a small contact book so the next PO pre-fills.

const path = require('path');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');
const PurchaseOrder = require('../models/PurchaseOrder');
const Vendor = require('../models/Vendor');
const Order = require('../models/Order');
const { nextNumber, bumpCounterTo } = require('../utils/sequence');
const {
  vendorKey, lineKey, chosenQuoteLines, costLineFromQuoteLine, costLineFromConfItem, buildPoLines,
} = require('../utils/poCost');

// A blank/unassigned vendor: no real supplier yet, so we never auto-number it.
const isUnassignedVendor = (name) => !vendorKey(name) || vendorKey(name) === vendorKey(UNASSIGNED);

const JP_LOGO_PATH = path.join(__dirname, '..', 'assets', 'jp-logo.png');
const badId = (id) => !mongoose.isValidObjectId(id);   // 404 instead of a CastError 500
const n = (v) => Number(v) || 0;
const money = (v) => `$${n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Pull the per-unit dollar figure out of a charge label so the cost-history
// panel can surface "what we paid per unit last time". Charge labels are built
// by the seeders/builder as "{name}: ${unit}/unit * {qty} units" (see
// buildPoLines), but they're free-text too — vendors and the owner edit them by
// hand — so this stays forgiving on whitespace/commas/plural.
//
// It must read only a REAL unit-cost token, not a stray number that happens to
// sit before "/unit" in prose (M1: "ship to 5/unit" must NOT yield 5). So the
// per-unit figure has to be MONEY-SHAPED: either it carries a "$", or it has a
// decimal cents part. A bare integer with no "$" (the prose case) is rejected.
// Returns the number (commas stripped) or null when there's no per-unit figure.
function parseUnitCost(label) {
  const s = String(label == null ? '' : label);
  // Case 1: explicit "$" — "$12/unit", "$1,000/unit", "$2.40 / unit".
  let m = s.match(/\$\s*([\d,]+(?:\.\d+)?)\s*\/\s*units?\b/i);
  // Case 2: no "$" but a decimal cents figure — "2.40/unit". A leading boundary
  // (start, or a non-word char) keeps it from latching onto "v2.40/unit" garble.
  if (!m) m = s.match(/(?:^|[^\w.])([\d,]+\.\d+)\s*\/\s*units?\b/i);
  if (!m) return null;
  const num = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

// Seed a draft PO from the order: vendor from printerName, shipping from the
// confirmation, items/charges from the CANONICAL chosen quote lines at COST
// (utils/poCost — blank only when the owner doesn't supply it, plus print per
// unit; setup as its own line; freight excluded), never client pricing. Uses the
// exact same cost-basis + line-selection helper as the confirmation seeder so an
// identical job yields an identical vendor PO regardless of entry path.
function _seedFromOrder(order, blanksProvided) {
  const conf = order.confirmation || {};
  const lines = chosenQuoteLines(order.quoteLines).map((l) => costLineFromQuoteLine(l, blanksProvided));
  const { items, charges, grandTotal, zeroCostCount } = buildPoLines(lines);
  return {
    vendorName: order.printerName || order.supplier || '',
    shipping: {
      name:          (conf.shipping && conf.shipping.name) || order.companyName || '',
      attention:     (conf.shipping && conf.shipping.attention) || order.clientName || '',
      streetAddress: (conf.shipping && conf.shipping.streetAddress) || '',
      cityStateZip:  (conf.shipping && conf.shipping.cityStateZip) || '',
    },
    items,
    charges,
    grandTotal,
    zeroCostCount,
  };
}

// ── Build POs from the APPROVED confirmation, split by supplier ───────────────
// The confirmation is what the client actually signed off, so it — not the
// pre-approval quote — is the right source for the real vendor POs. Each
// confirmation item carries its own `printerName` (who's actually making it),
// so an order spanning multiple suppliers (screen-printed tees + promo
// lighters) yields ONE PO per supplier, automatically. Costs use the item's
// internal `unitCost × total qty` (what JP pays the vendor), never client
// pricing — same cost basis as _seedFromOrder.

// Which supplier a confirmation item belongs to. Per-item printer wins; fall
// back to the order's printer/supplier; clearly bucket the rest as Unassigned.
const UNASSIGNED = 'Unassigned';
function _confItemSupplier(it, order) {
  return String(it && it.printerName || '').trim()
    || String(order.printerName || order.supplier || '').trim()
    || UNASSIGNED;
}

// Human label for a ship-to destination, used in the per-location PO callouts.
// Prefer the friendly label, then the recipient name, then the city line; fall
// back to a short form of the key so a half-filled destination still reads.
function _shipToName(st) {
  return String((st && (st.label || st.name || st.cityStateZip)) || '').trim()
    || (st && st.key ? `Location ${st.key}` : 'Location');
}

// Per-location split line for one confirmation item, e.g.
// "Ship split — Brooklyn HQ: 20, Newark Store: 15". Returns '' unless the
// order actually has destinations AND this item carries allocations to them —
// so single-location items (no allocations) produce nothing and the PO output
// stays byte-identical to today.
function _itemShipSplit(it, shipTos) {
  if (!Array.isArray(shipTos) || shipTos.length === 0) return '';
  const byKey = new Map(shipTos.map(st => [String(st && st.key || ''), st]));
  const parts = (Array.isArray(it && it.allocations) ? it.allocations : [])
    .filter(a => a && n(a.qty) > 0 && byKey.has(String(a.key)))
    .map(a => `${_shipToName(byKey.get(String(a.key)))}: ${n(a.qty)}`);
  return parts.length ? `Ship split — ${parts.join(', ')}` : '';
}

// True when an item is split across locations but the per-location allocations
// do NOT sum to the item's total size quantity (M4). A split PO built from a
// mismatched allocation would ship the wrong per-location counts, so we surface
// it as a warning before generating. Only flags items that actually carry
// allocations to real destinations — an unsplit item (no allocations) is fine.
function _allocMismatch(it, shipTos) {
  if (!Array.isArray(shipTos) || shipTos.length === 0) return false;
  const keys = new Set(shipTos.map(st => String(st && st.key || '')));
  const allocs = (Array.isArray(it && it.allocations) ? it.allocations : [])
    .filter(a => a && keys.has(String(a.key)));
  if (allocs.length === 0) return false;   // not split — nothing to reconcile
  const allocated = allocs.reduce((s, a) => s + n(a.qty), 0);
  const totalQty = (Array.isArray(it && it.sizes) ? it.sizes : []).reduce((s, sz) => s + n(sz.qty), 0);
  return allocated !== totalQty;
}

// Build one PO draft (existing PO shape) for a single supplier's items. Costs
// run through the SAME utils/poCost helper as the manual seeder: each confirmation
// item is matched back to its quote line to recover the granular blank/print/setup
// cost (so blanksProvided is honored and freight is excluded), falling back to the
// item's own unitCost when there's no match. `quoteLineByKey` maps a style|color|
// print key → quote line (built once per order by the caller).
function _seedPoForGroup(order, vendorName, groupItems, blanksProvided, quoteLineByKey) {
  const conf = order.confirmation || {};
  const shipTos = Array.isArray(conf.shipTos) ? conf.shipTos : [];
  const lines = (groupItems || []).map((it) => {
    const cl = costLineFromConfItem(it, blanksProvided, quoteLineByKey);
    cl._item = it;   // keep the source item so detailFor can read its size run + allocations
    return cl;
  });
  const { items, charges, grandTotal, zeroCostCount } = buildPoLines(lines, {
    detailFor: (cl) => {
      const it = cl._item || {};
      const sizes = Array.isArray(it.sizes) ? it.sizes : [];
      const out = [];
      // Size run, e.g. "S: 10 · M: 25 · L: 15" — what the vendor actually makes.
      const run = sizes.filter((sz) => n(sz.qty) > 0).map((sz) => `${sz.label || '—'}: ${n(sz.qty)}`).join(' · ');
      if (run) out.push(run);
      // Per-location breakdown — only when this order ships to multiple
      // destinations and this item is split across them (additive).
      const split = _itemShipSplit(it, shipTos);
      if (split) out.push(split);
      return out;
    },
  });
  const seeded = {
    vendorName,
    shipping: {
      name:          (conf.shipping && conf.shipping.name) || order.companyName || '',
      attention:     (conf.shipping && conf.shipping.attention) || order.clientName || '',
      streetAddress: (conf.shipping && conf.shipping.streetAddress) || '',
      cityStateZip:  (conf.shipping && conf.shipping.cityStateZip) || '',
    },
    items,
    charges,
    grandTotal,
    zeroCostCount,
    // Count of items whose per-location split doesn't reconcile to the item qty
    // (M4) — surfaced as a warning by the caller, never blocks generation.
    allocMismatchCount: (groupItems || []).reduce((c, it) => c + (_allocMismatch(it, shipTos) ? 1 : 0), 0),
  };
  // When the order ships to multiple destinations, lead the PO notes with a
  // concise roster of where things go so the vendor sees it at a glance. Only
  // added when shipTos is non-empty — single-location POs keep blank notes.
  const note = _shipNotes(shipTos);
  if (note) seeded.notes = note;
  return seeded;
}

// Concise multi-location roster for the PO Notes section. One line per
// destination with its address. '' when there are no destinations, so the PO's
// notes stay empty for single-location orders (output unchanged).
function _shipNotes(shipTos) {
  if (!Array.isArray(shipTos) || shipTos.length === 0) return '';
  const rows = shipTos
    .map((st) => {
      const where = [st && st.street, st && st.cityStateZip].map(s => String(s || '').trim()).filter(Boolean).join(', ');
      const label = _shipToName(st);
      return where ? `• ${label} — ${where}` : `• ${label}`;
    });
  return `Shipping to ${shipTos.length} locations:\n${rows.join('\n')}`;
}

// Group confirmation items by supplier, preserving first-seen order so the
// generated POs come out in a stable, sensible sequence. Grouped on the SAME
// normalized vendorKey (trim + collapse whitespace + lowercase) used for
// numbering and the skip check (H1/H3) so a vendor-name typo / stray whitespace
// can't fork a supplier into two POs or split it from its own number sequence.
function _groupConfBySupplier(order) {
  const confItems = (order.confirmation && Array.isArray(order.confirmation.items)) ? order.confirmation.items : [];
  const groups = new Map();   // vendorKey -> { vendorName, items: [] }
  confItems.forEach((it) => {
    const vendorName = _confItemSupplier(it, order);
    const key = vendorKey(vendorName);
    if (!groups.has(key)) groups.set(key, { vendorName, items: [] });
    groups.get(key).items.push(it);
  });
  return [...groups.values()];
}

// Map a style|color|print key → the order's chosen quote line, so the
// confirmation seeder can recover each item's granular blank/print/setup cost
// (and honor blanksProvided) instead of trusting the coarse bundled unitCost.
function _quoteLineIndex(order) {
  const map = new Map();
  chosenQuoteLines(order.quoteLines).forEach((l) => {
    const k = lineKey(l);
    if (!map.has(k)) map.set(k, l);   // first match wins; distinct print variants keep distinct keys
  });
  return map;
}

// POST /api/orders/:id/pos/from-confirmation — one PO per supplier from the
// approved confirmation. Skips suppliers that ALREADY have a PO on this order
// (matched case-insensitively by vendor name), so re-running is safe and never
// silently duplicates; the response says exactly what was created vs skipped.
const createPosFromConfirmation = async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ message: 'Project not found' });
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ message: 'Project not found' });

    const groups = _groupConfBySupplier(order);
    if (groups.length === 0) {
      return res.status(400).json({
        message: 'This project has no approved confirmation items to build POs from. Finalize the confirmation first.',
      });
    }

    // Local calendar day from the builder, same handling as createPo.
    const bodyDate = String((req.body && req.body.date) || '');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(bodyDate) ? new Date(`${bodyDate}T00:00:00Z`) : new Date();
    // Advisory skip (H3): by default we don't re-create a supplier that already
    // has a PO on this order, but the owner can force a regenerate. Either way we
    // NEVER silently drop a supplier's items — the response says what happened.
    const force = !!(req.body && req.body.force);

    // Quote-line lookup so each item recovers its granular cost (blanksProvided +
    // freight handling), shared by every group on this order.
    const quoteLineByKey = _quoteLineIndex(order);

    // Vendors that already have a PO on this order, keyed by the SAME normalized
    // vendorKey used for grouping (H3) — so a whitespace fork can't make a legit
    // second supplier look "already built" and get dropped.
    const existing = await PurchaseOrder.find({ orderId: order._id }).select('vendorName').lean();
    const existingKeys = new Set(existing.map(p => vendorKey(p.vendorName)).filter(Boolean));

    const created = [];
    const skipped = [];      // already had a PO; held back (unless force)
    const held = [];         // Unassigned/blank supplier — no number assigned yet (H1)
    const warnings = [];     // zero-cost line warnings (C3)
    for (const g of groups) {
      const key = vendorKey(g.vendorName);

      // H1: never auto-number a blank / "Unassigned" supplier. Hold its items
      // for when a real vendor is set, rather than minting an "Unassigned"
      // sequence that collides with the next unassigned order.
      if (isUnassignedVendor(g.vendorName)) { held.push(g.vendorName || UNASSIGNED); continue; }

      // Advisory skip: surface it, but only suppress when not forced (H3).
      if (key && existingKeys.has(key) && !force) { skipped.push(g.vendorName); continue; }

      // Pre-fill vendor contact card exactly like createPo (case-insensitive
      // exact-name match) — this is also where vendor.blanksProvided is finally
      // READ (it was written but never read before): the contact book remembers
      // each vendor's typical mode. Default true (JP supplies blanks ~99%).
      const vendor = await Vendor.findOne({
        name: new RegExp(`^${g.vendorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      }).lean();
      const blanksProvided = vendor && vendor.blanksProvided != null ? !!vendor.blanksProvided : true;

      const seeded = _seedPoForGroup(order, g.vendorName, g.items, blanksProvided, quoteLineByKey);
      if (seeded.zeroCostCount > 0) {
        warnings.push(`${g.vendorName}: ${seeded.zeroCostCount} line(s) have no cost — fill them in.`);
      }
      if (seeded.allocMismatchCount > 0) {
        warnings.push(`${g.vendorName}: ${seeded.allocMismatchCount} item(s) have a per-location split that doesn't add up to the item quantity — check the ship-to amounts.`);
      }
      const { zeroCostCount, allocMismatchCount, ...seedFields } = seeded;
      const po = await PurchaseOrder.create({
        orderId: order._id,
        poNumber: `#${(await nextNumber('po', g.vendorName)).padStart(3, '0')}`,
        date,
        vendorName: g.vendorName,
        contactName: vendor ? vendor.contactName : '',
        vendorAddress: vendor ? vendor.address : '',
        shipMethod: vendor ? vendor.shipMethod : '',
        blanksProvided,
        ...seedFields,
      });
      created.push(po);
      existingKeys.add(key);   // guard against a duplicate supplier key within one run
    }

    res.status(201).json({
      pos: created,
      summary: {
        created: created.length,
        vendors: created.map(p => p.vendorName),
        skipped,                                   // suppliers that already had a PO on this order (advisory)
        held,                                      // Unassigned/blank suppliers — set a vendor, then re-run
        warnings,                                  // zero-cost line warnings (C3)
        suppliers: groups.length,                  // distinct suppliers found in the confirmation
      },
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/:id/pos
const listPos = async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ message: 'Project not found' });
    const pos = await PurchaseOrder.find({ orderId: req.params.id }).sort({ createdAt: -1 }).lean();
    res.json({ pos });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/:id/pos — body optional { seed: true } pre-fills from the
// order; otherwise creates a mostly-blank PO. Vendor profile (matched by
// printerName) fills contact/address/shipMethod either way.
const createPo = async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ message: 'Project not found' });
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ message: 'Project not found' });

    const vendorNameRaw = (req.body && req.body.vendorName) || (order.printerName || order.supplier || '') || '';
    let vendor = null;
    if (vendorNameRaw) {
      vendor = await Vendor.findOne({ name: new RegExp(`^${vendorNameRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
    }
    // Honor the vendor's remembered mode (vendor.blanksProvided — previously
    // written but never read). Default true (JP supplies the blanks ~99%).
    const blanksProvided = vendor && vendor.blanksProvided != null ? !!vendor.blanksProvided : true;

    const seeded = req.body && req.body.seed === false ? {} : _seedFromOrder(order, blanksProvided);
    const vendorName = (req.body && req.body.vendorName) || seeded.vendorName || '';
    const { zeroCostCount = 0, ...seedFields } = seeded;

    // The builder sends its local calendar day (YYYY-MM-DD) — the server
    // clock can be a day ahead of the admin's evening, and every render pins
    // to UTC, so seeding from the server instant shows tomorrow's date.
    const bodyDate = String((req.body && req.body.date) || '');
    const date = /^\d{4}-\d{2}-\d{2}$/.test(bodyDate) ? new Date(`${bodyDate}T00:00:00Z`) : new Date();
    const po = await PurchaseOrder.create({
      orderId: order._id,
      // Per-vendor sequence — each printer numbered independently. A brand-new
      // printer seeds from 0 → #001; type the next number once to continue an
      // existing printer's old (e.g. Google Docs) run and it carries forward.
      poNumber: `#${(await nextNumber('po', vendorName)).padStart(3, '0')}`,
      date,
      vendorName,
      contactName: vendor ? vendor.contactName : '',
      vendorAddress: vendor ? vendor.address : '',
      shipMethod: vendor ? vendor.shipMethod : '',
      blanksProvided,
      ...seedFields,
    });
    // Surface zero-cost lines (C3) without blocking — the owner may intend a $0
    // sample line, but should be warned rather than shipping a silent $0.
    const warning = zeroCostCount > 0
      ? `${zeroCostCount} line(s) have no cost — fill them in.` : undefined;
    res.status(201).json(warning ? { ...po.toObject(), warning } : po);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// PUT /api/orders/pos/:poId — full update from the builder. Also upserts the
// vendor contact book so the next PO for this vendor pre-fills.
const updatePo = async (req, res) => {
  try {
    if (badId(req.params.poId)) return res.status(404).json({ message: 'PO not found' });
    const body = { ...req.body };
    delete body._id; delete body.orderId; delete body.createdAt; delete body.updatedAt;
    // Keep the grand total honest: recompute from charges when present.
    if (Array.isArray(body.charges)) {
      body.grandTotal = body.charges.reduce((s, c) => s + n(c && c.amount), 0);
    }
    // Snapshot the number BEFORE the write so we can tell a real hand-edit from a
    // routine save (H2). Auto-saves that don't touch the number must NOT bump any
    // counter — bumping on every save (and against whatever vendor happened to be
    // on the record) is how the wrong vendor's sequence got pushed forward.
    const prev = await PurchaseOrder.findById(req.params.poId).select('poNumber').lean();
    if (!prev) return res.status(404).json({ message: 'PO not found' });

    const po = await PurchaseOrder.findByIdAndUpdate(req.params.poId, { $set: body }, { new: true, runValidators: true }).lean();
    if (!po) return res.status(404).json({ message: 'PO not found' });

    // Only when the owner actually CHANGED the number (e.g. continuing a printer's
    // old Google Docs run) do we push that number's OWN vendor sequence past it,
    // so a future auto-assignment for THAT vendor can't collide (H2).
    const numberChanged = String(po.poNumber || '') !== String(prev.poNumber || '');
    if (numberChanged && po.poNumber) await bumpCounterTo('po', po.poNumber, po.vendorName);

    if (po.vendorName) {
      await Vendor.findOneAndUpdate(
        // Case-insensitive, like the createPo lookup — otherwise "heritage"
        // and "Heritage" become two contact-book entries.
        { name: new RegExp(`^${String(po.vendorName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
        { $set: {
          name: po.vendorName,
          contactName: po.contactName || '',
          address: po.vendorAddress || '',
          shipMethod: po.shipMethod || '',
          blanksProvided: !!po.blanksProvided,
        } },
        { upsert: true },
      ).catch(() => { /* contact book is best-effort */ });
    }
    res.json(po);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// DELETE /api/orders/pos/:poId
const deletePo = async (req, res) => {
  try {
    if (badId(req.params.poId)) return res.status(404).json({ message: 'PO not found' });
    await PurchaseOrder.findByIdAndDelete(req.params.poId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/vendors — the contact book, for the builder's vendor picker.
const listVendors = async (_req, res) => {
  try {
    const vendors = await Vendor.find({}).sort({ name: 1 }).lean();
    res.json({ vendors });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/po-cost-history?vendor=<name>&q=<term> — "cost memory" for the
// PO builder. Pulls recent POs for a vendor and flattens their order-summary
// charges into rows so the owner can re-use a past line (and see its per-unit
// cost) when pricing the next PO. Read-only; vendor match mirrors the
// case-insensitive exact-name lookup used by createPo/updatePo.
const poCostHistory = async (req, res) => {
  try {
    const vendor = String((req.query && req.query.vendor) || '').trim();
    const q = String((req.query && req.query.q) || '').trim().toLowerCase();
    if (!vendor) return res.json({ vendor: '', rows: [] });

    // Same exact-ish, case-insensitive vendor match the rest of the PO code uses
    // so "heritage" and "Heritage Screen Printing" resolve consistently. The PO
    // cap is the real bound on the work (each PO has only a handful of charges),
    // so cap POS in the QUERY (M2) — not rows after the fact — and lift the row
    // cap to a generous bound that won't bite normal usage.
    const PO_CAP = 60;
    const ROW_CAP = 250;
    const pos = await PurchaseOrder.find({
      vendorName: new RegExp(`^${vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    })
      .sort({ date: -1, createdAt: -1 })
      .limit(PO_CAP)
      .select('poNumber orderId date charges')
      .lean();

    const rows = [];
    let truncated = false;
    for (const po of pos) {
      for (const c of (po.charges || [])) {
        const label = String((c && c.label) || '');
        if (q && !label.toLowerCase().includes(q)) continue;
        if (rows.length >= ROW_CAP) { truncated = true; break; }
        rows.push({
          poNumber: po.poNumber || '',
          orderId:  po.orderId || null,
          date:     po.date || null,
          label,
          amount:   n(c && c.amount),
          unitCost: parseUnitCost(label),   // null when the line has no per-unit figure
        });
      }
      if (truncated) break;
    }

    // `truncated` lets the UI say "showing the most recent N" instead of silently
    // hiding older rows (M2).
    res.json({ vendor, rows, truncated });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/pos/:poId/pdf — server-rendered PDF in the house format.
const poPdf = async (req, res) => {
  try {
    if (badId(req.params.poId)) return res.status(404).json({ message: 'PO not found' });
    const po = await PurchaseOrder.findById(req.params.poId).lean();
    if (!po) return res.status(404).json({ message: 'PO not found' });

    const doc = new PDFDocument({ size: 'LETTER', margin: 54 });
    const left = doc.page.margins.left;
    const pageW = doc.page.width - left - doc.page.margins.right;
    const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'po';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="${slug(po.vendorName)}-x-jp-po-${slug(po.poNumber)}.pdf"`);
    doc.pipe(res);

    const INK = '#111111', MUTED = '#555555', GREEN = '#1a3d2b', LINE = '#dddddd';

    // Header: logo + title
    const logoSize = 40;
    try { doc.image(JP_LOGO_PATH, left, left, { fit: [logoSize, logoSize] }); } catch (_) { /* optional */ }
    doc.font('Helvetica-Bold').fontSize(16).fillColor(INK)
      .text(`${po.vendorName || 'Vendor'} x Joint Printing PO`, left + logoSize + 12, left + 12);
    doc.y = left + logoSize + 18;
    doc.moveTo(left, doc.y).lineTo(left + pageW, doc.y).strokeColor(LINE).lineWidth(1).stroke();
    doc.moveDown(1);

    const field = (label, value) => {
      if (!value) return;
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(`${label}: `, { continued: true });
      doc.font('Helvetica').fillColor(MUTED).text(String(value));
      doc.moveDown(0.15);
    };
    const section = (title) => {
      doc.moveDown(0.7);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(GREEN).text(title, left);
      doc.moveDown(0.3);
    };
    // A, B, … Z, AA, AB … so a long PO never wraps its item letters back to 'A'.
    const alpha = (i, baseCode) => {
      let s = '', x = Math.max(0, i | 0);
      do { s = String.fromCharCode(baseCode + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
      return s;
    };

    doc.x = left;
    field('Purchase Order Number', po.poNumber);
    field('Date', po.date ? new Date(po.date).toLocaleDateString('en-US', { timeZone: 'UTC' }) : '');
    field('Due Date', po.dueDate ? new Date(po.dueDate).toLocaleDateString('en-US', { timeZone: 'UTC' }) : '');
    field('Proof', po.proofRequired ? 'Required before production run' : '');
    field('Printer Name', po.vendorName);
    field('Contact Information', po.contactName);
    field('Address', po.vendorAddress);

    const sh = po.shipping || {};
    if (sh.name || sh.attention || sh.streetAddress || sh.cityStateZip) {
      section('Shipping Info');
      field('Shipping Name', sh.name);
      field('Attention Name', sh.attention);
      field('Street Address', sh.streetAddress);
      field('City, State, Zip', sh.cityStateZip);
    }
    if (po.shipMethod) {
      doc.moveDown(0.4);
      field('Ship Method', po.shipMethod);
    }

    if ((po.items || []).length > 0) {
      section(po.blanksProvided ? 'Product/Print Info - (blanks provided)' : 'Product/Print Order Summary');
      po.items.forEach((it, i) => {
        const letter = alpha(i, 65);
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK)
          .text(`${letter})  ${it.title || ''}`, left + 8);
        (it.details || []).forEach((d, j) => {
          const sub = alpha(j, 97);
          doc.font('Helvetica').fontSize(10).fillColor(MUTED)
            .text(`${sub})  ${d}`, left + 30);
        });
        doc.moveDown(0.3);
      });
    }

    if ((po.charges || []).length > 0) {
      section('Order Summary');
      po.charges.forEach((c) => {
        const rowY = doc.y;
        doc.font('Helvetica').fontSize(10).fillColor(MUTED)
          .text(`•  ${c.label || ''}`, left + 8, rowY, { width: pageW - 110 });
        // Pin the amount to the label's first line so a wrapped label can't
        // drag the figure out of vertical alignment.
        doc.font('Helvetica-Bold').fillColor(INK)
          .text(money(c.amount), left + pageW - 90, rowY, { width: 90, align: 'right' });
        doc.moveDown(0.2);
      });
    }

    if (po.notes) {
      section('Notes');
      doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(po.notes, left + 8, doc.y, { width: pageW - 16 });
    }

    doc.moveDown(1);
    doc.moveTo(left, doc.y).lineTo(left + pageW, doc.y).strokeColor(LINE).lineWidth(1).stroke();
    doc.moveDown(0.5);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(GREEN)
      .text(`Grand Total: ${money(po.grandTotal)}`, left, doc.y, { width: pageW, align: 'right' });

    doc.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ message: e.message });
  }
};

module.exports = { listPos, createPo, createPosFromConfirmation, updatePo, deletePo, listVendors, poCostHistory, poPdf, parseUnitCost };
// Exported for unit tests — pure helpers for the multi-location ship-split PO output.
module.exports._itemShipSplit = _itemShipSplit;
module.exports._shipNotes = _shipNotes;
module.exports._seedPoForGroup = _seedPoForGroup;
module.exports._seedFromOrder = _seedFromOrder;
module.exports._groupConfBySupplier = _groupConfBySupplier;
module.exports._quoteLineIndex = _quoteLineIndex;
