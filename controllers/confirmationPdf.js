// controllers/confirmationPdf.js
//
// Server-rendered confirmation PDF. Built with pdfkit (pure JS — no headless
// Chrome, nothing that can blow up a Render deploy). Reads the saved
// Order.confirmation sub-document and lays it out as a clean order-confirmation
// sheet. Totals mirror the client's computeTotals(): percent custom-lines apply
// to the running subtotal in order.

const PDFDocument = require('pdfkit');
const axios = require('axios');
const path = require('path');
const Order = require('../models/Order');
const StudioLibraryItem = require('../models/StudioLibraryItem');

// The green "JP" logo box, embedded at the top of every confirmation PDF.
const JP_LOGO_PATH = path.join(__dirname, '..', 'assets', 'jp-logo.png');

const money = (n) =>
  '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// data:image/png;base64,... → Buffer (pdfkit only reads PNG/JPEG)
function dataUrlToBuffer(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const m = dataUrl.match(/^data:image\/(png|jpe?g);base64,(.+)$/i);
  if (!m) return null;
  try { return Buffer.from(m[2], 'base64'); } catch (_) { return null; }
}

// Resolve an image value (base64 data URL OR an http(s) URL — e.g. an R2 link)
// to a Buffer pdfkit can embed. Images moved to R2 are stored as URLs, so the
// PDF fetches them; legacy base64 still works. Returns null on any failure so a
// single bad image never aborts the whole PDF.
async function resolveImageBuffer(value) {
  if (!value || typeof value !== 'string') return null;
  if (value.startsWith('data:')) return dataUrlToBuffer(value);
  if (/^https?:\/\//i.test(value)) {
    try {
      const r = await axios.get(value, { responseType: 'arraybuffer', timeout: 15000 });
      return Buffer.from(r.data);
    } catch (_) { return null; }
  }
  return null;
}

const C = { green: '#1a3d2b', ink: '#111111', muted: '#666666', line: '#d9d9d2', band: '#f1f1ec' };

// POST /api/orders/:id/confirmation/pdf
const confirmationPdf = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ message: 'Not found' });

    const conf  = order.confirmation || {};
    const items = Array.isArray(conf.items) ? conf.items : [];

    // Build a lookup of mockup thumbnails by mockupNum so items that reference
    // a saved studio mockup (via the picker dropdown) can have their thumbnail
    // embedded in the PDF even when mockupSnapshots[] is empty. Previously the
    // PDF only knew about images explicitly attached via the upload path or
    // legacy customMockupDataUrl — a dropdown-picked mockup rendered as a
    // headerless block with size tables and no image at all.
    const norm = (n) => String(n || '').replace(/^#/, '').replace(/^0+/, '').toUpperCase();
    const referenced = new Set();
    items.forEach((it) => { if (it && it.mockupNum) referenced.add(norm(it.mockupNum)); });
    const thumbByNorm = {};
    if (referenced.size > 0) {
      const libs = await StudioLibraryItem.find({ store: 'mockups' })
        .select('name thumbnail data pageState.mockupNum').lean();
      libs.forEach((m) => {
        const entry = (m.thumbnail || m.data) ? { front: m.thumbnail, back: m.data } : null;
        if (!entry) return;
        const k = norm(m.pageState && m.pageState.mockupNum);
        if (k && referenced.has(k)) thumbByNorm[k] = entry;
        // Name fallback: the builder's picker stores the mockup NAME when an
        // item has no number — match it here too or the image silently
        // vanishes from the PDF while looking fine in the builder.
        const nk = norm(m.name);
        if (nk && referenced.has(nk) && !thumbByNorm[nk]) thumbByNorm[nk] = entry;
      });
    }

    // ── Totals (mirror models/Order.js computeConfirmationTotals exactly) ────
    const itemsSubtotal = items.reduce((s, it) =>
      s + (it.sizes || []).reduce((ss, sz) => ss + (Number(sz.qty) || 0) * (Number(sz.unitPrice) || 0), 0), 0);
    const locationTax = Order.computeLocationTax(conf);
    let running = itemsSubtotal;
    const customLines = [];
    (conf.customLines || []).forEach(l => {
      // Double-tax guard (C3): when per-location tax is active, a legacy tax
      // customLine must NOT also apply — per-location tax wins. Mirrors the model
      // so the PDF the client pays from is taxed exactly once.
      if (locationTax.active && Order.isTaxCustomLine(l)) return;
      const isPercent = !!l.isPercent;
      const amount = Number(l.amount) || 0;
      const value = isPercent ? running * amount / 100 : amount;
      running += value;
      const baseLabel = l.label || (isPercent ? 'Adjustment' : 'Add-on');
      // Mirror the builder's live preview, which appends "- 5%" to percent
      // lines so the client sees the rate, not just the resulting dollars.
      // Previously only the computed dollar value was carried through, so the
      // "%" the user typed never made it into the PDF.
      const label = isPercent ? `${baseLabel} - ${amount}%` : baseLabel;
      customLines.push({ label, value });
    });
    // Per-location sales tax (multi-ship-to). No-op unless a shipTo carries a
    // taxRate > 0; otherwise the PDF is byte-identical. Rendered as its own
    // total rows after the add-on lines, mirroring the grand total in
    // models/Order.js and the client approval page.
    locationTax.lines.forEach(l => {
      running += l.value;
      customLines.push({ label: l.label, value: l.value });
    });
    const grandTotal = Order.roundCents(running);   // snap to cents (H4)

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
    // JP logo box to the left of the wordmark (falls back to text-only if the
    // image can't be read — never let a logo hiccup abort the PDF).
    const logoSize = 44;
    try { doc.image(JP_LOGO_PATH, left, left, { fit: [logoSize, logoSize] }); } catch (_) { /* logo optional */ }
    doc.fillColor(C.green).font('Helvetica-Bold').fontSize(22)
      .text('JOINT PRINTING', left + logoSize + 12, left + 10);
    doc.y = Math.max(doc.y, left + logoSize);
    doc.moveDown(0.15);
    doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(15)
      .text(conf.orderTitle || `${order.companyName || order.clientName || 'Project'} — Order Confirmation`);
    const meta = [
      order.projectNumber ? `Project #${order.projectNumber}` : null,
      order.orderNumber   ? `Invoice #${order.orderNumber}`   : null,
      conf.orderDate
        // orderDate is a pure calendar date stored as UTC midnight — render in
        // UTC so it can't slip a day depending on the server's timezone.
        ? new Date(conf.orderDate).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
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
    for (const [idx, it] of items.entries()) {
      ensure(150);

      // Always surface the style code alongside the product/brand label.
      // Printer is internal — never on the client-facing confirmation.
      const productLabel = it.productName || it.brandName || '';
      const titleParts = [
        productLabel && it.styleCode ? `${productLabel} (${it.styleCode})` : (productLabel || it.styleCode),
        it.color,
        it.printType,
      ].filter(Boolean);
      // Last-resort fallback: if nobody filled in productName / brand /
      // styleCode / color / printType, infer SOMETHING from the sizes
      // breakdown so the PDF doesn't render as a row of nameless "Item 1"
      // / "Item 2" blocks (the user got bit by this with 2 pairs of
      // shorts that came out as anonymous tables). One unit = "1 piece",
      // mixed sizes = "N pieces across M sizes".
      let fallbackTitle = '';
      if (titleParts.length === 0) {
        const live = (it.sizes || []).filter(sz => Number(sz.qty) > 0);
        const totalQty = live.reduce((s, sz) => s + (Number(sz.qty) || 0), 0);
        if (totalQty > 0) {
          fallbackTitle = live.length > 1
            ? `${totalQty} pieces across ${live.length} sizes`
            : `${totalQty} × ${live[0].label || 'size'}`;
        } else {
          fallbackTitle = `Line item ${idx + 1}`;
        }
      }
      doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink)
        .text(titleParts.join('   ·   ') || fallbackTitle);
      doc.moveDown(0.3);

      // mockup thumbnails — prefer explicit attachments, fall back to the
      // library thumbnail for items that just reference a mockupNum.
      const snaps  = (await Promise.all((it.mockupSnapshots || []).map(s => resolveImageBuffer(s && s.dataUrl)))).filter(Boolean);
      const legacy = await resolveImageBuffer(it.customMockupDataUrl);
      const lib = it.mockupNum ? thumbByNorm[norm(it.mockupNum)] : null;
      // The back composite only ships when the admin opted in (showBack) —
      // unconditionally embedding it put plain blank garment backs on client
      // docs that the builder preview never showed.
      const libSides = lib ? (it.showBack ? [lib.front, lib.back] : [lib.front]) : [];
      const libBufs = (await Promise.all(libSides.map(v => resolveImageBuffer(v)))).filter(Boolean);
      const imgs   = snaps.length ? snaps : (legacy ? [legacy] : libBufs);
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
    }

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
