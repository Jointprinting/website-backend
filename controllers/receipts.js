// controllers/receipts.js
//
// The receipt inbox: upload a paid receipt (or a whole zip of them), let Claude
// read it, review/correct, then book a clean expense into the ledger. Every
// step is admin-controlled — the AI only fills fields, Nate confirms. Files are
// stored in R2 so the originals live forever (the durable archive he used to
// keep by hand in Google Drive).

const Receipt = require('../models/Receipt');
const Transaction = require('../models/Transaction');
const r2 = require('../services/r2');
const scanner = require('../services/receiptScanner');

const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const digits = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '');

const EXT_MIME = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  heic: 'image/heic', heif: 'image/heic', webp: 'image/webp', gif: 'image/gif',
};
const isReceiptFile = (name) => {
  const ext = String(name).split('.').pop().toLowerCase();
  return !!EXT_MIME[ext] && !/(^|\/)__MACOSX\//.test(name) && !/\/\._/.test(name) && !/\.DS_Store$/.test(name);
};

// Store one receipt file → create a pending Receipt → enqueue it for reading.
async function _ingest(buffer, mime, fileName, source, folderHint = '') {
  const fileUrl = await r2.uploadBuffer(buffer, mime, 'receipts');
  const rec = await Receipt.create({
    fileUrl, fileName: fileName || '', fileMime: mime, fileSize: buffer.length,
    folderHint: folderHint || '',
    status: 'pending', source: source || 'upload',
  });
  scanner.enqueue(rec._id);
  return rec;
}

// The folder a zipped receipt sat in is almost always the vendor. Take the
// deepest real directory (so Alibaba/<actual supplier> keeps the supplier),
// skipping the generic top-level "Receipts for Purchases" wrapper and macOS junk.
function _folderHint(path) {
  const segs = String(path).split('/');
  segs.pop(); // drop the filename
  const dirs = segs.filter((d) => d && d !== '__MACOSX' && !/^receipts?\s+for\s+purchases?$/i.test(d));
  return dirs.length ? dirs[dirs.length - 1] : '';
}

// POST /api/receipts — body { fileDataUrl, fileName }. Single receipt (image or
// PDF, incl. iPhone HEIC). The file is saved first, then queued for reading.
const upload = async (req, res) => {
  try {
    if (!r2.isR2Configured()) return res.status(503).json({ message: 'File storage (R2) is not configured.' });
    const dataUrl = (req.body && req.body.fileDataUrl) || '';
    const m = String(dataUrl).match(/^data:([a-z0-9.+/-]+);base64,(.+)$/i);
    if (!m) return res.status(400).json({ message: 'Provide a receipt file (fileDataUrl).' });
    const buffer = Buffer.from(m[2], 'base64');
    const rec = await _ingest(buffer, m[1].toLowerCase(), (req.body && req.body.fileName) || '', 'upload');
    res.json({ receipt: rec, queue: scanner.queueStatus() });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// POST /api/receipts/batch — multipart: a single .zip of receipts (or several
// loose files). Each receipt-like entry is stored + queued. For the historical
// back-catalog upload.
const batch = async (req, res) => {
  try {
    if (!r2.isR2Configured()) return res.status(503).json({ message: 'File storage (R2) is not configured.' });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ message: 'No files uploaded.' });
    const created = [];
    const skipped = [];
    const failed = [];
    const unzipper = require('unzipper');

    // One file's failure (corrupt PDF, transient R2 hiccup) must not abort the
    // whole batch — keep going and report what failed.
    const ingestSafe = async (buf, mime, name, folderHint) => {
      try { const rec = await _ingest(buf, mime, name, 'batch', folderHint); created.push(rec._id); }
      catch (e) { failed.push(`${name}: ${e.message}`); }
    };

    for (const f of files) {
      const isZip = /\.zip$/i.test(f.originalname) || f.mimetype === 'application/zip';
      if (isZip) {
        const dir = await unzipper.Open.buffer(f.buffer);
        for (const entry of dir.files) {
          if (entry.type !== 'File' || !isReceiptFile(entry.path)) { if (entry.type === 'File') skipped.push(entry.path); continue; }
          let buf;
          try { buf = await entry.buffer(); } catch (e) { failed.push(`${entry.path}: ${e.message}`); continue; }
          const ext = entry.path.split('.').pop().toLowerCase();
          await ingestSafe(buf, EXT_MIME[ext], entry.path.split('/').pop(), _folderHint(entry.path));
        }
      } else if (isReceiptFile(f.originalname)) {
        const ext = f.originalname.split('.').pop().toLowerCase();
        await ingestSafe(f.buffer, EXT_MIME[ext] || f.mimetype, f.originalname, '');
      } else {
        skipped.push(f.originalname);
      }
    }
    res.json({ created: created.length, skipped, failed, queue: scanner.queueStatus() });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// GET /api/receipts?status=&year= — the inbox. Excludes the heavy rawResponse.
// Also returns status counts so the UI can badge the queue.
const list = async (req, res) => {
  try {
    const q = {};
    if (req.query.status) q.status = req.query.status;
    if (req.query.year) q.year = Number(req.query.year);
    const receipts = await Receipt.find(q).sort({ createdAt: -1 }).limit(1000).lean();
    const agg = await Receipt.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
    const counts = {};
    agg.forEach((a) => { counts[a._id] = a.n; });
    res.json({ receipts, counts, queue: scanner.queueStatus() });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// GET /api/receipts/:id — full record incl. rawResponse (audit trail).
const getOne = async (req, res) => {
  try {
    const rec = await Receipt.findById(req.params.id).select('+rawResponse').lean();
    if (!rec) return res.status(404).json({ message: 'Receipt not found.' });
    res.json({ receipt: rec });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// POST /api/receipts/:id/reprocess — re-read a receipt (after a failure, or to
// re-run with a different model). Resets it to pending and re-queues.
const reprocess = async (req, res) => {
  try {
    const rec = await Receipt.findById(req.params.id);
    if (!rec) return res.status(404).json({ message: 'Receipt not found.' });
    rec.status = 'pending'; rec.attempts = 0; rec.extractionError = '';
    await rec.save();
    scanner.enqueue(rec._id);
    res.json({ receipt: rec, queue: scanner.queueStatus() });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// PUT /api/receipts/:id — edit the extracted fields / status (e.g. correct a
// vendor, or mark `ignored`). Nate's manual control over every field.
const update = async (req, res) => {
  try {
    const rec = await Receipt.findById(req.params.id);
    if (!rec) return res.status(404).json({ message: 'Receipt not found.' });
    if (req.body.extracted) rec.extracted = { ...rec.extracted.toObject(), ...req.body.extracted };
    if (req.body.status) rec.status = req.body.status;
    if (req.body.flags) rec.flags = req.body.flags;
    await rec.save();
    res.json({ receipt: rec });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// POST /api/receipts/:id/confirm — book the (reviewed) receipt into the ledger.
// Body may carry corrected fields. Creates/updates the linked expense
// Transaction with the receipt file attached. A same-order/same-amount match
// triggers a 409 duplicate warning unless `force` is set — Nate stays in control.
const confirm = async (req, res) => {
  try {
    const rec = await Receipt.findById(req.params.id);
    if (!rec) return res.status(404).json({ message: 'Receipt not found.' });

    const e = { ...rec.extracted.toObject(), ...(req.body.extracted || {}) };
    const amount = Math.abs(num(e.amount));
    if (!amount) return res.status(400).json({ message: 'An amount is required to book this receipt.' });
    const date = e.date ? new Date(e.date) : new Date();
    const orderNumber = digits(e.orderNumber);
    const category = e.category || 'Other';

    // Duplicate guard: a booked/imported expense with the same order # and the
    // same amount is very likely the same cost already in the ledger.
    if (!req.body.force) {
      const dupQ = { type: 'expense', amount, _id: { $exists: true } };
      if (orderNumber) dupQ.orderNumber = orderNumber; else dupQ.party = e.vendor || '';
      const dup = await Transaction.findOne(dupQ).lean();
      if (dup && String(dup._id) !== String(rec.transactionId || '')) {
        return res.status(409).json({
          message: 'A matching expense is already in the ledger.',
          duplicate: { id: dup._id, date: dup.date, party: dup.party, amount: dup.amount, category: dup.category, orderNumber: dup.orderNumber },
        });
      }
    }

    const fields = {
      date, type: 'expense', category, orderNumber,
      party: e.vendor || '', description: e.summary || '', amount,
      receiptUrl: rec.fileUrl, source: 'receipt',
    };
    let txn;
    if (rec.transactionId) {
      txn = await Transaction.findByIdAndUpdate(rec.transactionId, fields, { new: true });
    }
    if (!txn) txn = await Transaction.create(fields);

    rec.extracted = e;
    rec.status = 'booked';
    rec.transactionId = txn._id;
    rec.reviewedAt = new Date();
    await rec.save();
    res.json({ receipt: rec, transaction: txn });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// DELETE /api/receipts/:id — remove a receipt. Leaves any already-booked ledger
// entry alone (delete that from the ledger if you want it gone). Best-effort
// deletes the stored file when it wasn't booked.
const remove = async (req, res) => {
  try {
    const rec = await Receipt.findById(req.params.id);
    if (!rec) return res.json({ ok: true });
    if (rec.status !== 'booked') await r2.deleteByUrl(rec.fileUrl);
    await rec.deleteOne();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// GET /api/receipts/reconcile?year= — double-check the receipts against the
// ledger Nate imported from his spreadsheet. For each read receipt we look for a
// matching expense (same order # & amount, or same vendor & amount near the
// date) and classify it: matched / new (in receipts, missing from the sheet) /
// conflict (amounts disagree). This is the "the receipts are the real source of
// truth — double-check the sheet" pass.
const reconcile = async (req, res) => {
  try {
    const recQ = { status: { $in: ['review', 'booked'] } };
    if (req.query.year) recQ.year = Number(req.query.year);
    const receipts = await Receipt.find(recQ).lean();
    const txnQ = { type: 'expense' };
    if (req.query.year) txnQ.year = Number(req.query.year);
    const txns = await Transaction.find(txnQ).lean();

    const within = (a, b, days) => Math.abs(new Date(a) - new Date(b)) <= days * 86400000;
    const matched = [], conflicts = [], missing = [];
    const usedTxn = new Set();

    receipts.forEach((rc) => {
      const amt = round2(num(rc.extracted && rc.extracted.amount));
      const ord = digits(rc.extracted && rc.extracted.orderNumber);
      const vendor = ((rc.extracted && rc.extracted.vendor) || '').toLowerCase();
      // Best candidate: same order # if we have one, else same vendor near date.
      const cand = txns.find((t) => {
        if (usedTxn.has(String(t._id))) return false;
        if (ord && digits(t.orderNumber) === ord) return true;
        if (!ord && vendor && (t.party || '').toLowerCase().includes(vendor.split(' ')[0]) &&
            rc.extracted && rc.extracted.date && within(t.date, rc.extracted.date, 7)) return true;
        return false;
      });
      const row = { receiptId: rc._id, vendor: rc.extracted && rc.extracted.vendor, amount: amt, date: rc.extracted && rc.extracted.date, orderNumber: ord, fileUrl: rc.fileUrl };
      if (!cand) { missing.push(row); return; }
      usedTxn.add(String(cand._id));
      if (round2(cand.amount) === amt) matched.push({ ...row, transactionId: cand._id });
      else conflicts.push({ ...row, transactionId: cand._id, ledgerAmount: round2(cand.amount), delta: round2(amt - cand.amount) });
    });

    res.json({
      summary: { receipts: receipts.length, matched: matched.length, conflicts: conflicts.length, missingFromLedger: missing.length },
      matched, conflicts, missing,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// POST /api/receipts/bulk-reconcile — one-click "sort these out" for the review
// pile: (1) link each receipt to the matching ledger expense (attach file, no
// new charge), matching on order # / the read vendor / OR the folder name so a
// "Contract-DTG" folder links even when the invoice is branded "First Amendment
// Tees"; (2) book obvious new OVERHEAD (software/fees/travel — no order # needed)
// that isn't in the ledger; (3) leave job costs and anything flagged/odd
// (refunds, no-amount, ambiguous) for manual review. Never double-counts: only
// matches ledger rows that don't already carry a receipt.
const bulkReconcile = async (req, res) => {
  try {
    const OVERHEAD = new Set(['Software', 'Sales Tax', 'Other']);
    const ODD = /refund|credit|not a (charge|receipt|supplier|business|vendor|invoice|merch)|personal|estimate|\bquote\b/i;
    const receipts = await Receipt.find({ status: 'review' }).lean();
    const txns = await Transaction.find({
      type: 'expense', $or: [{ receiptUrl: '' }, { receiptUrl: { $exists: false } }],
    }).lean();
    const within = (a, b, days) => a && b && Math.abs(new Date(a) - new Date(b)) <= days * 86400000;
    const usedTxn = new Set();
    let linked = 0; let booked = 0; let unmatched = 0;
    for (const rc of receipts) {
      const e = rc.extracted || {};
      const amt = round2(num(e.amount));
      const ord = digits(e.orderNumber);
      const tokens = [e.vendor, rc.folderHint]
        .map((s) => (((s || '').toLowerCase().match(/[a-z&]+/)) || [''])[0])
        .filter((t) => t && t.length > 2);
      const cand = txns.find((t) => {
        if (usedTxn.has(String(t._id))) return false;
        if (!amt || Math.abs(round2(t.amount) - amt) > 0.02) return false;
        if (ord && digits(t.orderNumber) === ord) return true;
        const party = (t.party || '').toLowerCase(); const desc = (t.description || '').toLowerCase();
        if (tokens.some((tok) => party.includes(tok) || desc.includes(tok)) && (!e.date || within(t.date, e.date, 45))) return true;
        return false;
      });
      if (cand) {
        usedTxn.add(String(cand._id));
        await Transaction.findByIdAndUpdate(cand._id, { receiptUrl: rc.fileUrl });
        await Receipt.findByIdAndUpdate(rc._id, { status: 'booked', transactionId: cand._id, reviewedAt: new Date() });
        linked++;
        continue;
      }
      const odd = (rc.flags || []).some((f) => ODD.test(f));
      if (amt > 0 && rc.confidence === 'high' && OVERHEAD.has(e.category) && !odd) {
        const txn = await Transaction.create({
          date: e.date || new Date(), type: 'expense', category: e.category || 'Other',
          orderNumber: ord, party: e.vendor || rc.folderHint || '', description: e.summary || '',
          amount: amt, receiptUrl: rc.fileUrl, source: 'receipt',
        });
        await Receipt.findByIdAndUpdate(rc._id, { status: 'booked', transactionId: txn._id, reviewedAt: new Date() });
        booked++;
        continue;
      }
      unmatched++;
    }
    res.json({ linked, booked, unmatched });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// DELETE /api/receipts — wipe every receipt that hasn't been booked, so a batch
// read with bad data can be cleared and re-uploaded cleanly. Best-effort deletes
// the stored files. Booked receipts (already linked to the ledger) are kept.
const clearAll = async (req, res) => {
  try {
    const recs = await Receipt.find({ status: { $ne: 'booked' } }).select('fileUrl').lean();
    await Promise.all(recs.map((r) => r2.deleteByUrl(r.fileUrl).catch(() => {})));
    const result = await Receipt.deleteMany({ status: { $ne: 'booked' } });
    res.json({ deleted: result.deletedCount || 0 });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

module.exports = { upload, batch, list, getOne, reprocess, update, confirm, remove, reconcile, bulkReconcile, clearAll };
