// controllers/confirmationPdf.js
//
// Server-rendered confirmation PDF. Built with pdfkit (pure JS — no headless
// Chrome, nothing that can blow up a Render deploy). Reads the saved
// Order.confirmation sub-document and lays it out as a clean order-confirmation
// sheet. Totals mirror the client's computeTotals(): percent custom-lines apply
// to the running subtotal in order.

const PDFDocument = require('pdfkit');
const Order = require('../models/Order');

const money = (n) =>
  '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// data:image/png;base64,... → Buffer (pdfkit only reads PNG/JPEG)
function dataUrlToBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
  if (!m) return null;
  try { return Buffer.from(m[2], 'base64'); } catch (_) { return null; }
}

const C = { green: '#1a3d2b', ink: '#111111', muted: '#666666', line: '#d9d9d2', band: '#f1f1ec' };

// POST /api/orders/:id/confirmation/pdf
const confirmationPdf = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ message: 'Not found' });

    const conf  = order.confirmation || {};
    const items = Array.isArray(conf.items) ? conf.items : [];

    // ── Totals (mirror client computeTotals) ────────────────────────────────
    const itemsSubtotal = items.reduce((s, it) =>
      s + (it.sizes || []).reduce((ss, sz) => ss + (Number(sz.qty) || 0) * (Number(sz.unitPrice) || 0), 0), 0);
    let running = itemsSubtotal;
    const customLines = (conf.customLines || []).map(l => {
      const value = l.isPercent
        ? running * (Number(l.amount) || 0) / 100
        : (Number(l.amount) || 0);
      running += value;
      return { label: l.label || (l.isPercent ? 'Adjustment' : 'Add-on'), value };
    });
    const grandTotal = running;

    const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
    // Filename uses the company name first — easier to spot in a Downloads
    // folder than "confirmation-project-132". Sanitized to filesystem-safe
    // characters; falls back to project # then _id if no name is set.
    const slug = (s) => String(s || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const nameSlug = slug(order.companyName) || slug(order.clientName)
      || `project-${order.projectNumber || order._id}`;
    const filename = `confirmation-${nameSlug}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    const left  = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const pageW = right - left;
    const bottom = doc.page.height - doc.page.margins.bottom;

    const hr = (y) => doc.moveTo(left, y).lineTo(right, y).strokeColor(C.line).lineWidth(1).stroke();
    const ensure = (need) => { if (doc.y + need > bottom) doc.addPage(); };

    // ── Header ──────────────────────────────────────────────────────────────
    doc.fillColor(C.green).font('Helvetica-Bold').fontSize(22).text('JOINT PRINTING', left, left);
    doc.moveDown(0.15);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(15)
      .text(conf.orderTitle || `${order.companyName || order.clientName || 'Project'} — Order Confirmation`);
    const meta = [
      order.projectNumber ? `Project #${order.projectNumber}` : null,
      order.orderNumber   ? `Invoice #${order.orderNumber}`   : null,
      conf.orderDate
        ? new Date(conf.orderDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : null,
    ].filter(Boolean).join('    ·    ');
    if (meta) doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(meta, { paragraphGap: 2 });
    doc.moveDown(0.4);
    hr(doc.y);
    doc.moveDown(0.8);

    // ── Ship to ─────────────────────────────────────────────────────────────
    const sh = conf.shipping || {};
    const shipLines = [
      sh.name,
      sh.attention ? `Attn: ${sh.attention}` : null,
      sh.streetAddress,
      sh.cityStateZip,
    ].filter(Boolean);
    if (shipLines.length) {
      doc.font('Helvetica-Bold').fontSize(8).fillColor(C.muted).text('SHIP TO');
      doc.font('Helvetica').fontSize(10).fillColor(C.ink);
      shipLines.forEach(l => doc.text(l));
      doc.moveDown(0.9);
    }

    // ── Items ───────────────────────────────────────────────────────────────
    items.forEach((it, idx) => {
      ensure(150);

      // Always surface the style code alongside the product/brand label.
      // Printer is internal — never on the client-facing confirmation.
      const productLabel = it.productName || it.brandName || '';
      const titleParts = [
        productLabel && it.styleCode ? `${productLabel} (${it.styleCode})` : (productLabel || it.styleCode),
        it.color,
        it.printType,
      ].filter(Boolean);
      doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink)
        .text(titleParts.join('   ·   ') || `Item ${idx + 1}`);
      doc.moveDown(0.3);

      // mockup thumbnails
      const snaps  = (it.mockupSnapshots || []).map(s => dataUrlToBuffer(s && s.dataUrl)).filter(Boolean);
      const legacy = dataUrlToBuffer(it.customMockupDataUrl);
      const imgs   = snaps.length ? snaps : (legacy ? [legacy] : []);
      if (imgs.length) {
        ensure(110);
        const rowY = doc.y;
        let ix = left;
        imgs.slice(0, 5).forEach(buf => {
          try { doc.image(buf, ix, rowY, { fit: [92, 92] }); ix += 100; } catch (_) { /* skip bad image */ }
        });
        doc.y = rowY + 100;
      }

      // sizes table
      const sizes = (it.sizes || []).filter(sz => Number(sz.qty) > 0);
      if (sizes.length) {
        ensure(24 + sizes.length * 18);
        const cols = [left, left + 200, left + 320, left + 430];
        const headerY = doc.y;
        doc.rect(left, headerY, pageW, 18).fill(C.band);
        doc.fillColor(C.muted).font('Helvetica-Bold').fontSize(8);
        doc.text('SIZE', cols[0] + 6, headerY + 5);
        doc.text('QTY',  cols[1] + 6, headerY + 5);
        doc.text('UNIT', cols[2] + 6, headerY + 5);
        doc.text('LINE', cols[3] + 6, headerY + 5);
        let ry = headerY + 18;
        doc.font('Helvetica').fontSize(9).fillColor(C.ink);
        sizes.forEach(sz => {
          const lineTotal = (Number(sz.qty) || 0) * (Number(sz.unitPrice) || 0);
          doc.fillColor(C.ink).text(String(sz.label || '—'), cols[0] + 6, ry + 4);
          doc.text(String(Number(sz.qty) || 0),  cols[1] + 6, ry + 4);
          doc.text(money(sz.unitPrice),           cols[2] + 6, ry + 4);
          doc.text(money(lineTotal),              cols[3] + 6, ry + 4);
          doc.moveTo(left, ry + 18).lineTo(right, ry + 18).strokeColor(C.line).lineWidth(0.5).stroke();
          ry += 18;
        });
        const itemSubtotal = sizes.reduce((s, sz) => s + (Number(sz.qty) || 0) * (Number(sz.unitPrice) || 0), 0);
        doc.font('Helvetica-Bold').fontSize(9).fillColor(C.ink)
          .text(`Item subtotal   ${money(itemSubtotal)}`, left, ry + 4, { width: pageW, align: 'right' });
        doc.y = ry + 20;
      }
      doc.moveDown(0.9);
    });

    // ── Totals ──────────────────────────────────────────────────────────────
    ensure(40 + customLines.length * 16);
    hr(doc.y);
    doc.moveDown(0.5);
    const totalRow = (label, value, bold) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10)
        .fillColor(bold ? C.green : C.ink)
        .text(`${label}    ${value}`, left, doc.y, { width: pageW, align: 'right' });
      doc.moveDown(bold ? 0.2 : 0.35);
    };
    totalRow('Subtotal', money(itemsSubtotal), false);
    customLines.forEach(l => totalRow(l.label, money(l.value), false));
    doc.moveDown(0.2);
    totalRow('TOTAL', money(grandTotal), true);

    // ── Footer ──────────────────────────────────────────────────────────────
    doc.moveDown(1.2);
    if (doc.y < bottom - 60) {
      hr(doc.y);
      doc.moveDown(0.5);
      doc.font('Helvetica').fontSize(8).fillColor(C.muted);
      const footerLines = [
        'Credit Card Payments: 2.99% charge added to total',
        'ACH Bank Transfers: 1% charge added to total',
        'Venmo: 1.9% + $0.10    @jointprinting',
      ];
      footerLines.forEach(l => doc.text(l, left, doc.y, { width: pageW, align: 'left' }));
    }

    doc.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ message: e.message });
    else { try { res.end(); } catch (_) {} }
  }
};

module.exports = { confirmationPdf };
