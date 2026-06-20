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
      blanksProvided: vendor ? !!vendor.blanksProvided : false,
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

    doc.x = left;
    field('Purchase Order Number', po.poNumber);
    field('Date', po.date ? new Date(po.date).toLocaleDateString('en-US', { timeZone: 'UTC' }) : '');
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
        const letter = String.fromCharCode(65 + (i % 26));
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK)
          .text(`${letter})  ${it.title || ''}`, left + 8);
        (it.details || []).forEach((d, j) => {
          const sub = String.fromCharCode(97 + (j % 26));
          doc.font('Helvetica').fontSize(10).fillColor(MUTED)
            .text(`${sub})  ${d}`, left + 30);
        });
        doc.moveDown(0.3);
      });
    }

    if ((po.charges || []).length > 0) {
      section('Order Summary');
      po.charges.forEach((c) => {
        doc.font('Helvetica').fontSize(10).fillColor(MUTED)
          .text(`•  ${c.label || ''}`, left + 8, doc.y, { continued: false, width: pageW - 110 });
        doc.font('Helvetica-Bold').fillColor(INK)
          .text(money(c.amount), left + pageW - 90, doc.y - 12, { width: 90, align: 'right' });
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

module.exports = { listPos, createPo, updatePo, deletePo, listVendors, poPdf };
