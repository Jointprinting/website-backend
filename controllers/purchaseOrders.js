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

const JP_LOGO_PATH = path.join(__dirname, '..', 'assets', 'jp-logo.png');
const badId = (id) => !mongoose.isValidObjectId(id);   // 404 instead of a CastError 500
const n = (v) => Number(v) || 0;
const money = (v) => `$${n(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Pull the per-unit dollar figure out of a charge label so the cost-history
// panel can surface "what we paid per unit last time". Charge labels are built
// by the seeders/builder as "{name}: ${unit}/unit * {qty} units" (see
// _seedFromOrder / _seedPoForGroup), but they're free-text too — vendors and
// the owner edit them by hand — so this stays forgiving: an optional "$", a
// number with optional thousands commas + decimals, optional space, then
// "/unit" or "/units". Returns the number (commas stripped) or null when there's
// no per-unit figure (e.g. a flat "set-up fee" line).
function parseUnitCost(label) {
  const m = String(label == null ? '' : label).match(/\$?\s*([\d,]+(?:\.\d+)?)\s*\/\s*units?\b/i);
  if (!m) return null;
  const num = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

// Seed a draft PO from the order: vendor from printerName, shipping from the
// confirmation, items/charges from the chosen quote lines at COST (what JP
// pays the vendor — blank+print per unit plus setup), never client pricing.
function _seedFromOrder(order) {
  const lines = (order.quoteLines || []).filter(l => l && (l.accepted || !l.group));
  const conf = order.confirmation || {};
  const items = [];
  const charges = [];
  lines.forEach((l) => {
    const qty = n(l.qty);
    const unitCost = n(l.blankCost) + n(l.printCost);
    const title = `${l.description || l.styleCode || 'Item'}${qty ? `, ${qty} units` : ''}`;
    const details = [];
    if (l.printType) details.push([l.printType, l.printDetails].filter(Boolean).join(' · '));
    if (unitCost && qty) details.push(`${money(unitCost)}/unit * ${qty} units = ${money(unitCost * qty)}`);
    if (n(l.setupCost)) details.push(`${money(l.setupCost)} setup`);
    items.push({ title, details });
    if (unitCost && qty) charges.push({ label: `${l.description || l.styleCode || 'Item'}: ${money(unitCost)}/unit * ${qty} units`, amount: unitCost * qty });
    if (n(l.setupCost)) charges.push({ label: `${l.description || l.styleCode || 'Item'} set-up fee`, amount: n(l.setupCost) });
  });
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
    grandTotal: charges.reduce((s, c) => s + n(c.amount), 0),
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

// Display name for a confirmation item: product override, else brand + style.
function _confItemName(it) {
  const label = String(it.productName || '').trim()
    || [it.brandName, it.styleCode].map(s => String(s || '').trim()).filter(Boolean).join(' ');
  return label || 'Item';
}

// Which supplier a confirmation item belongs to. Per-item printer wins; fall
// back to the order's printer/supplier; clearly bucket the rest as Unassigned.
const UNASSIGNED = 'Unassigned';
function _confItemSupplier(it, order) {
  return String(it && it.printerName || '').trim()
    || String(order.printerName || order.supplier || '').trim()
    || UNASSIGNED;
}

// Build one PO draft (existing PO shape) for a single supplier's items.
function _seedPoForGroup(order, vendorName, groupItems) {
  const conf = order.confirmation || {};
  const items = [];
  const charges = [];
  groupItems.forEach((it) => {
    const sizes = Array.isArray(it.sizes) ? it.sizes : [];
    const qty = sizes.reduce((s, sz) => s + n(sz.qty), 0);
    const unitCost = n(it.unitCost);
    const name = _confItemName(it);
    const colorTitle = it.color ? `${name}, ${it.color}` : name;
    const title = `${colorTitle}${qty ? `, ${qty} units` : ''}`;

    const details = [];
    if (it.printType) details.push([it.printType, it.color].filter(Boolean).join(' · '));
    // Size run, e.g. "S: 10 · M: 25 · L: 15" — what the vendor actually makes.
    const run = sizes.filter(sz => n(sz.qty) > 0).map(sz => `${sz.label || '—'}: ${n(sz.qty)}`).join(' · ');
    if (run) details.push(run);
    if (unitCost && qty) details.push(`${money(unitCost)}/unit * ${qty} units = ${money(unitCost * qty)}`);
    items.push({ title, details });

    if (unitCost && qty) {
      charges.push({ label: `${colorTitle}: ${money(unitCost)}/unit * ${qty} units`, amount: unitCost * qty });
    }
  });
  return {
    vendorName,
    shipping: {
      name:          (conf.shipping && conf.shipping.name) || order.companyName || '',
      attention:     (conf.shipping && conf.shipping.attention) || order.clientName || '',
      streetAddress: (conf.shipping && conf.shipping.streetAddress) || '',
      cityStateZip:  (conf.shipping && conf.shipping.cityStateZip) || '',
    },
    items,
    charges,
    grandTotal: charges.reduce((s, c) => s + n(c.amount), 0),
  };
}

// Group confirmation items by supplier, preserving first-seen order so the
// generated POs come out in a stable, sensible sequence.
function _groupConfBySupplier(order) {
  const confItems = (order.confirmation && Array.isArray(order.confirmation.items)) ? order.confirmation.items : [];
  const groups = new Map();   // displayName -> { vendorName, items: [] }
  confItems.forEach((it) => {
    const vendorName = _confItemSupplier(it, order);
    const key = vendorName.toLowerCase();
    if (!groups.has(key)) groups.set(key, { vendorName, items: [] });
    groups.get(key).items.push(it);
  });
  return [...groups.values()];
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

    // Vendors that already have a PO on this order — skip them so a re-run
    // doesn't duplicate. (Unassigned never auto-skips on a blank name.)
    const existing = await PurchaseOrder.find({ orderId: order._id }).select('vendorName').lean();
    const existingNames = new Set(existing.map(p => String(p.vendorName || '').trim().toLowerCase()).filter(Boolean));

    const created = [];
    const skipped = [];
    for (const g of groups) {
      const key = g.vendorName.trim().toLowerCase();
      if (key && existingNames.has(key)) { skipped.push(g.vendorName); continue; }

      const seeded = _seedPoForGroup(order, g.vendorName, g.items);
      // Pre-fill vendor contact card exactly like createPo (case-insensitive
      // exact-name match). Unassigned/blank → no match, blank card.
      let vendor = null;
      if (g.vendorName && g.vendorName !== UNASSIGNED) {
        vendor = await Vendor.findOne({
          name: new RegExp(`^${g.vendorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        }).lean();
      }
      const po = await PurchaseOrder.create({
        orderId: order._id,
        poNumber: `#${(await nextNumber('po', g.vendorName)).padStart(3, '0')}`,
        date,
        vendorName: g.vendorName,
        contactName: vendor ? vendor.contactName : '',
        vendorAddress: vendor ? vendor.address : '',
        shipMethod: vendor ? vendor.shipMethod : '',
        blanksProvided: true,   // JP supplies the blanks ~99% of the time — default yes; toggle off for the rare vendor-supplied job
        ...seeded,
      });
      created.push(po);
      if (key) existingNames.add(key);   // guard against a duplicate supplier name within one run
    }

    res.status(201).json({
      pos: created,
      summary: {
        created: created.length,
        vendors: created.map(p => p.vendorName),
        skipped,                                   // suppliers that already had a PO on this order
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

    const seeded = req.body && req.body.seed === false ? {} : _seedFromOrder(order);
    const vendorName = (req.body && req.body.vendorName) || seeded.vendorName || '';
    let vendor = null;
    if (vendorName) {
      vendor = await Vendor.findOne({ name: new RegExp(`^${vendorName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
    }

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
      blanksProvided: true,   // JP supplies the blanks ~99% of the time — default yes; toggle off for the rare vendor-supplied job
      ...seeded,
    });
    res.status(201).json(po);
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
    const po = await PurchaseOrder.findByIdAndUpdate(req.params.poId, { $set: body }, { new: true, runValidators: true }).lean();
    if (!po) return res.status(404).json({ message: 'PO not found' });

    // A hand-edited PO number (e.g. continuing a printer's old Google Docs run)
    // bumps THAT vendor's sequence past itself so auto-assignment never collides.
    if (po.poNumber) await bumpCounterTo('po', po.poNumber, po.vendorName);

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
    // so "heritage" and "Heritage Screen Printing" resolve consistently.
    const pos = await PurchaseOrder.find({
      vendorName: new RegExp(`^${vendor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    })
      .sort({ date: -1, createdAt: -1 })
      .limit(25)                       // newest ~25 POs is plenty of memory
      .select('poNumber orderId date charges')
      .lean();

    const rows = [];
    const ROW_CAP = 40;
    for (const po of pos) {
      for (const c of (po.charges || [])) {
        const label = String((c && c.label) || '');
        if (q && !label.toLowerCase().includes(q)) continue;
        rows.push({
          poNumber: po.poNumber || '',
          orderId:  po.orderId || null,
          date:     po.date || null,
          label,
          amount:   n(c && c.amount),
          unitCost: parseUnitCost(label),   // null when the line has no per-unit figure
        });
        if (rows.length >= ROW_CAP) break;
      }
      if (rows.length >= ROW_CAP) break;
    }

    res.json({ vendor, rows });
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
