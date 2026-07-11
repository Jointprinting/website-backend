// controllers/lookbookPdf.js
//
// Server-rendered LOOKBOOK PDF — the polished, client-branded deck the owner
// sends to show off the mockups designed for an order. Built with pdfkit (pure
// JS, Render-safe — no headless Chrome). Pulls saved studio mockups (front
// composite = thumbnail, optional back = data), lays them over a branded cover +
// gallery content pages. The layout math is pure and unit-tested
// (controllers/__tests__/lookbookPdf.test.js).
//
//   POST /api/studio/lookbook/pdf
//   body: { mockupIds:[ordered ids], title?, subtitle?, clientName?,
//           projectNumber?, layout?: 'auto'|'editorial'|'grid'|'contact',
//           showBack?: bool, showLabels?: bool }

const PDFDocument = require('pdfkit');
const path = require('path');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const { resolveImageBuffer } = require('../utils/pdfImage');
let sharp = null;
try { sharp = require('sharp'); } catch (_) { /* knockout degrades to the raw image */ }

// The green "JP" logo box, reused from the confirmation PDF.
const JP_LOGO_PATH = path.join(__dirname, '..', 'assets', 'jp-logo.png');

const PAGE = { w: 612, h: 792 };   // US Letter, portrait
const MARGIN = 40;
const GUTTER = 14;

// A deep green-black cover, then light, gallery-like content pages.
const C = {
  cover:    '#0e1a13',
  coverHair:'#2c5a3f',
  eyebrow:  '#7fcf9e',
  coverSub: '#c5ccc7',
  coverMeta:'#8b958e',
  green:    '#1a3d2b',
  accent:   '#22c55e',
  ink:      '#15201a',
  muted:    '#6b766f',
  faint:    '#9aa39c',
  card:     '#f5f6f4',
  cardLine: '#e4e7e3',
  white:    '#ffffff',
};

// ── pure layout math (exported for tests) ───────────────────────────────────

const LAYOUTS = {
  editorial: { cols: 1, rows: 1 },   // one hero per page
  grid:      { cols: 2, rows: 2 },   // 4 per page
  contact:   { cols: 3, rows: 3 },   // 9 per page — contact sheet
};

// Auto-pick a layout from how many mockups are in the deck: a couple get the
// hero treatment, a handful get a 2×2, a lot get a contact sheet.
function pickLayout(count) {
  const n = Number(count) || 0;
  if (n <= 2) return 'editorial';
  if (n <= 8) return 'grid';
  return 'contact';
}

// Honor an explicit layout when it's a real one; otherwise auto-pick.
function resolveLayout(layout, count) {
  return (layout && layout !== 'auto' && LAYOUTS[layout]) ? layout : pickLayout(count);
}

function perPage(layout) {
  const g = LAYOUTS[layout] || LAYOUTS.grid;
  return g.cols * g.rows;
}

function pageCount(layout, count) {
  const n = Number(count) || 0;
  if (n <= 0) return 0;
  return Math.ceil(n / perPage(layout));
}

// Split a content box into a cols×rows grid of equal cells separated by a
// gutter. Row-major order (left→right, top→bottom) — pdfkit's top-left origin.
function gridCells(box, cols, rows, gutter) {
  const g = Number(gutter) || 0;
  const cw = (box.w - (cols - 1) * g) / cols;
  const ch = (box.h - (rows - 1) * g) / rows;
  const cells = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({ x: box.x + c * (cw + g), y: box.y + r * (ch + g), w: cw, h: ch });
    }
  }
  return cells;
}

// Contain-fit an intrinsic image size inside a box (centered), returning the
// rect to draw at. Degrades to the padded box when any size is unusable.
function fitContain(imgW, imgH, box, pad) {
  const p = Number(pad) || 0;
  const bw = box.w - p * 2, bh = box.h - p * 2;
  const base = { x: box.x + p, y: box.y + p, w: Math.max(0, bw), h: Math.max(0, bh) };
  if (!(imgW > 0) || !(imgH > 0) || !(bw > 0) || !(bh > 0)) return base;
  const sc = Math.min(bw / imgW, bh / imgH);
  const w = imgW * sc, h = imgH * sc;
  return { x: box.x + p + (bw - w) / 2, y: box.y + p + (bh - h) / 2, w, h };
}

// ── drawing (pdfkit; top-left origin) ───────────────────────────────────────

// Place a buffer inside a box, contain-fit + centered. Returns true if drawn.
function placeImage(doc, buf, box, pad) {
  if (!buf) return false;
  let dim;
  try { dim = doc.openImage(buf); } catch (_) { return false; }
  const r = fitContain(dim.width, dim.height, box, pad);
  try { doc.image(buf, r.x, r.y, { width: r.w, height: r.h }); return true; } catch (_) { return false; }
}

function drawCover(doc, info) {
  doc.save();
  doc.rect(0, 0, PAGE.w, PAGE.h).fill(C.cover);

  // Header: JP logo + wordmark, with a hairline beneath.
  const ly = MARGIN;
  try { doc.image(JP_LOGO_PATH, MARGIN, ly, { fit: [34, 34] }); } catch (_) { /* logo optional */ }
  doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(13)
    .text('JOINT PRINTING', MARGIN + 44, ly + 9);
  doc.moveTo(MARGIN, ly + 50).lineTo(PAGE.w - MARGIN, ly + 50)
    .strokeColor(C.coverHair).lineWidth(0.8).stroke();

  // Title block, sitting a little above center.
  const cw = PAGE.w - MARGIN * 2;
  doc.fillColor(C.eyebrow).font('Helvetica-Bold').fontSize(11)
    .text('LOOKBOOK', MARGIN, PAGE.h * 0.38, { characterSpacing: 3, width: cw });
  doc.moveDown(0.45);
  doc.fillColor(C.white).font('Helvetica-Bold').fontSize(34)
    .text(info.title, MARGIN, doc.y, { width: cw, lineGap: 2 });
  if (info.subtitle) {
    doc.moveDown(0.5);
    doc.fillColor(C.coverSub).font('Helvetica').fontSize(13).text(info.subtitle, { width: cw });
  }

  // Bottom meta + site.
  const meta = [
    info.projectNumber ? `Project #${info.projectNumber}` : null,
    `${info.count} ${info.count === 1 ? 'style' : 'styles'}`,
    info.date,
  ].filter(Boolean).join('    ·    ');
  doc.fillColor(C.coverMeta).font('Helvetica').fontSize(10)
    .text(meta, MARGIN, PAGE.h - MARGIN - 38, { width: cw });
  doc.fillColor(C.accent).font('Helvetica').fontSize(9)
    .text('jointprinting.com', MARGIN, PAGE.h - MARGIN - 14, { width: cw, align: 'right' });
  doc.restore();
}

function drawChrome(doc, info, pageNum, totalPages) {
  doc.save();
  doc.rect(0, 0, PAGE.w, PAGE.h).fill(C.white);

  // Running header: wordmark left, client right, hairline beneath.
  doc.fillColor(C.green).font('Helvetica-Bold').fontSize(9).text('JOINT PRINTING', MARGIN, MARGIN - 10);
  if (info.client) {
    doc.fillColor(C.muted).font('Helvetica').fontSize(9)
      .text(info.client, PAGE.w / 2, MARGIN - 10, { width: PAGE.w / 2 - MARGIN, align: 'right' });
  }
  doc.moveTo(MARGIN, MARGIN + 6).lineTo(PAGE.w - MARGIN, MARGIN + 6).strokeColor(C.cardLine).lineWidth(0.8).stroke();

  // Footer: date left, page x/y center, site right, hairline above.
  const fy = PAGE.h - MARGIN + 4;
  doc.moveTo(MARGIN, fy - 6).lineTo(PAGE.w - MARGIN, fy - 6).strokeColor(C.cardLine).lineWidth(0.8).stroke();
  doc.fillColor(C.faint).font('Helvetica').fontSize(8).text(info.date, MARGIN, fy, { width: 160 });
  if (totalPages > 1) {
    doc.fillColor(C.faint).text(`${pageNum} / ${totalPages}`, PAGE.w / 2 - 60, fy, { width: 120, align: 'center' });
  }
  doc.fillColor(C.accent).text('jointprinting.com', PAGE.w - MARGIN - 160, fy, { width: 160, align: 'right' });
  doc.restore();
}

function drawCell(doc, cell, mk, opts) {
  doc.save();
  const radius = 8;
  doc.roundedRect(cell.x, cell.y, cell.w, cell.h, radius).fill(C.card);
  doc.roundedRect(cell.x + 0.5, cell.y + 0.5, cell.w - 1, cell.h - 1, radius)
    .lineWidth(0.8).strokeColor(C.cardLine).stroke();

  const labelH = opts.showLabels ? Math.min(26, Math.max(16, cell.h * 0.1)) : 0;
  const imgArea = { x: cell.x, y: cell.y, w: cell.w, h: cell.h - labelH };
  const pad = Math.max(8, cell.w * 0.04);

  const front = mk._frontBuf;
  const back = opts.showBack ? mk._backBuf : null;

  let drew = false;
  if (front && back) {
    const splitX = imgArea.w * 0.6;
    drew = placeImage(doc, front, { x: imgArea.x, y: imgArea.y, w: splitX, h: imgArea.h }, pad) || drew;
    drew = placeImage(doc, back, { x: imgArea.x + splitX, y: imgArea.y, w: imgArea.w - splitX, h: imgArea.h }, pad) || drew;
    const dx = imgArea.x + splitX;
    doc.moveTo(dx, imgArea.y + pad).lineTo(dx, imgArea.y + imgArea.h - pad).lineWidth(0.5).strokeColor(C.cardLine).stroke();
  } else {
    drew = placeImage(doc, front, imgArea, pad);
  }
  if (!drew) {
    doc.fillColor(C.faint).font('Helvetica').fontSize(9)
      .text('image unavailable', imgArea.x, imgArea.y + imgArea.h / 2 - 5, { width: imgArea.w, align: 'center' });
  }

  if (labelH > 0) {
    const ly = cell.y + cell.h - labelH;
    doc.rect(cell.x, ly, cell.w, labelH).fill(C.white);
    doc.moveTo(cell.x + pad, ly).lineTo(cell.x + cell.w - pad, ly).lineWidth(0.5).strokeColor(C.cardLine).stroke();
    const fs = Math.min(11, Math.max(7.5, cell.w * 0.026));
    const ty = ly + (labelH - fs) / 2 - 1;
    let tx = cell.x + pad;
    const num = mk.mockupNum ? `#${mk.mockupNum}` : '';
    if (num) {
      doc.fillColor(C.accent).font('Helvetica-Bold').fontSize(fs);
      doc.text(num, tx, ty, { lineBreak: false });
      tx += doc.widthOfString(num) + 6;
    }
    const name = (mk.name || '').trim();
    if (name) {
      doc.fillColor(C.ink).font('Helvetica-Bold').fontSize(fs);
      const maxW = cell.x + cell.w - pad - tx;
      let label = name;
      if (doc.widthOfString(label) > maxW) {
        while (label.length > 1 && doc.widthOfString(label + '…') > maxW) label = label.slice(0, -1);
        label += '…';
      }
      doc.text(label, tx, ty, { lineBreak: false });
    }
  }
  doc.restore();
}

// Knock the white studio backdrop out of a mockup composite so the garment sits
// on the page's own card instead of a hard white rectangle — the same "clean
// background" look the web viewer offers, baked into the download. Pure pixel
// threshold via sharp (present on Render); ANY failure returns the original
// buffer, so the PDF can never break on a knockout attempt.
const KNOCKOUT_THRESHOLD = 240;   // min channel value counted as "white"
async function knockoutWhite(buf) {
  if (!buf || !sharp) return buf;
  try {
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels || 4;
    if (ch < 4) return buf;
    const out = Buffer.from(data);
    const t = KNOCKOUT_THRESHOLD;
    for (let i = 0; i < out.length; i += ch) {
      if (out[i] >= t && out[i + 1] >= t && out[i + 2] >= t) out[i + 3] = 0;
    }
    return await sharp(out, { raw: { width: info.width, height: info.height, channels: ch } }).png().toBuffer();
  } catch (_) {
    return buf;   // sharp unhappy → ship the mockup as-is
  }
}

// ── builder (shared by the studio POST and the public GET) ───────────────────

// Resolve + (optionally) knock out every image up front, in parallel.
async function resolveDeckImages(ordered, { showBack, knockout }) {
  await Promise.all(ordered.map(async (mk) => {
    let front = await resolveImageBuffer(mk.thumbnail);
    let back = showBack ? await resolveImageBuffer(mk.data) : null;
    if (knockout) { front = await knockoutWhite(front); if (back) back = await knockoutWhite(back); }
    mk._frontBuf = front;
    mk._backBuf = back;
    mk.mockupNum = mk.pageState && mk.pageState.mockupNum ? String(mk.pageState.mockupNum) : '';
  }));
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Draw + stream the deck to `res`. `ordered` is already image-resolved. This is
// the whole PDF; both entry points (studio POST, public GET) funnel through it.
function streamLookbookPdf(res, { ordered, info, layout, showBack, showLabels, filename }) {
  // margin: 0 — the lookbook is laid out with fully absolute geometry (PAGE /
  // MARGIN constants), so pdfkit's own margins must be off, or text drawn near
  // the edges (the footer) trips its flow-based auto-pagination and inserts
  // blank pages between ours.
  const doc = new PDFDocument({ size: 'LETTER', margin: 0, autoFirstPage: false });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  doc.addPage();
  drawCover(doc, info);

  const { cols, rows } = LAYOUTS[layout];
  const per = cols * rows;
  const totalContentPages = pageCount(layout, ordered.length);
  const contentBox = {
    x: MARGIN, y: MARGIN + 20,
    w: PAGE.w - MARGIN * 2, h: PAGE.h - (MARGIN + 20) - (MARGIN + 6),
  };
  for (let p = 0; p < totalContentPages; p++) {
    doc.addPage();
    drawChrome(doc, info, p + 1, totalContentPages);
    const cells = gridCells(contentBox, cols, rows, GUTTER);
    for (let i = 0; i < per; i++) {
      const idx = p * per + i;
      if (idx >= ordered.length) break;
      drawCell(doc, cells[i], ordered[idx], { showLabels, showBack });
    }
  }
  doc.end();
}

// The full build from a set of ordered library docs + presentation options.
// `docs` carry { name, client, thumbnail, data, pageState } (lean StudioLibraryItem).
async function buildLookbookPdf(res, { docs, title, subtitle, clientName, projectNumber, layout, showBack, showLabels, knockout }) {
  const ordered = (docs || []).filter(Boolean);
  if (!ordered.length) { if (!res.headersSent) res.status(404).json({ message: 'No matching mockups found.' }); return; }

  const back = showBack !== false;      // default on (only drawn when a back exists)
  const labels = showLabels !== false;  // default on
  const lay = resolveLayout(layout, ordered.length);
  await resolveDeckImages(ordered, { showBack: back, knockout: !!knockout });

  const client = String(clientName || ordered[0].client || '').trim();
  const ttl = String(title || '').trim() || (client ? `${client} Lookbook` : 'Lookbook');
  const proj = projectNumber || (ordered[0].pageState && ordered[0].pageState.projectNumber) || '';
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const info = { title: ttl, subtitle: String(subtitle || '').trim(), client, projectNumber: proj, date, count: ordered.length };
  const filename = `lookbook-${slug(client) || slug(ttl) || 'joint-printing'}.pdf`;

  streamLookbookPdf(res, { ordered, info, layout: lay, showBack: back, showLabels: labels, filename });
}

// ── controller (studio POST /api/studio/lookbook/pdf) ────────────────────────

async function lookbookPdf(req, res) {
  try {
    const body = req.body || {};
    const ids = Array.isArray(body.mockupIds) ? body.mockupIds.filter(Boolean).map(String) : [];
    if (!ids.length) return res.status(400).json({ message: 'Select at least one mockup for the lookbook.' });

    const docs = await StudioLibraryItem.find({ _id: { $in: ids }, store: 'mockups' })
      .select('name client thumbnail data pageState.mockupNum pageState.projectNumber').lean();
    // Preserve the caller's order (the order they arranged the deck in).
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!ordered.length) return res.status(404).json({ message: 'No matching mockups found.' });

    await buildLookbookPdf(res, {
      docs: ordered,
      title: body.title, subtitle: body.subtitle, clientName: body.clientName,
      projectNumber: body.projectNumber, layout: body.layout,
      showBack: body.showBack, showLabels: body.showLabels, knockout: body.knockout,
    });
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ message: e.message });
    else { try { res.end(); } catch (_) { /* already streaming */ } }
  }
}

module.exports = {
  lookbookPdf,
  buildLookbookPdf,      // used by the public token-gated download (controllers/lookbooks.js)
  knockoutWhite,
  // exported for unit tests
  pickLayout, resolveLayout, perPage, pageCount, gridCells, fitContain, LAYOUTS,
};
