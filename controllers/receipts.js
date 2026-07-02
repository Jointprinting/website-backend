// controllers/receipts.js
//
// The receipt inbox: upload a paid receipt (or a whole zip of them), let Claude
// read it, review/correct, then book a clean expense into the ledger. Every
// step is admin-controlled — the AI only fills fields, Nate confirms. Files are
// stored in R2 so the originals live forever (the durable archive he used to
// keep by hand in Google Drive).

const Receipt = require('../models/Receipt');
const Transaction = require('../models/Transaction');
const Order = require('../models/Order');
const Vendor = require('../models/Vendor');
const r2 = require('../services/r2');
const scanner = require('../services/receiptScanner');
const { normalizeOrderNumber } = require('./finances');
const { isSelf } = require('../services/selfIdentity');

const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const digits = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '');

// Find the Order a receipt's order/invoice number links to. Order.orderNumber is
// FREE-FORM ("0000021", "#21", "PO-021") while a receipt's number is digits-ish,
// so we normalize the receipt to the canonical key (digits only, leading zeros
// stripped — the same key the whole finance system uses), pull a candidate set
// whose number contains that digit run, then confirm with normalizeOrderNumber on
// both sides. The contains-regex catches the non-digit-decorated forms ("#21",
// "PO-021") that an anchored ^0*<key>$ would miss; the canonical filter is what
// actually decides the match, so "21" never links to "121"/"210". `key` is pure
// digits (no metachars), so the RegExp is injection-safe. The matched Order is the
// SOURCE OF TRUTH for who the client is (its companyName/clientName) — that's how an
// income invoice gets the right party instead of the seller off the letterhead.
// Returns the Order POJO or null ('' / no-digits key never matches a blank order#).
async function _findLinkedOrder(rawOrderNumber) {
  const key = normalizeOrderNumber(rawOrderNumber);
  if (!key) return null;
  const candidates = await Order.find({ orderNumber: new RegExp(key) })  // coarse: contains the digit run
    .select('orderNumber companyName clientName projectNumber totalValue paid')
    .lean();
  const exact = candidates.filter((o) => normalizeOrderNumber(o.orderNumber) === key);  // canonical: the real match
  if (!exact.length) return null;
  // On the rare order-number collision, pick deterministically: prefer a named one.
  return exact.find((o) => (o.companyName || o.clientName)) || exact[0];
}

// Receipt→vendor LEARNING (conservative). When an expense receipt is booked with
// a real vendor (party) AND an order #, remember "this printer did this order" on
// the Vendor record. This is the link that lets the system pre-fill the right
// printer on a future PO/receipt for that order and surface it on the vendor card.
// It's a remembered HINT only — never an irreversible auto-action:
//   • only a NAMED expense party that isn't us (the self-seller) is learned;
//   • a vendor row is upserted by the SAME case-insensitive exact-name match the
//     PO contact book uses, so it doesn't fork an existing printer;
//   • we keep ONE entry per canonical order number (refreshing its timestamp), so
//     re-confirming the same receipt never piles up duplicate links;
//   • blanksProvided is only $setOnInsert (a new vendor defaults true) so learning
//     never overwrites a printer's owner-set mode.
// PURE decision (no DB) — exported + tested. Returns { name, key } to learn, or
// null to skip. We only learn from a NAMED expense party that isn't us, with a
// real (canonical) order #. Anything else (income, blank/self party, no order #)
// is deliberately NOT remembered — keeps the hint conservative and never wrong.
function vendorOrderLearnPlan(party, type, rawOrderNumber) {
  const name = String(party || '').trim();
  if (type !== 'expense' || !name || isSelf(name)) return null;
  const key = normalizeOrderNumber(rawOrderNumber);
  if (!key) return null;
  return { name, key };
}

// Best-effort: a failure here must never block booking the ledger entry.
async function _learnVendorOrder(party, type, rawOrderNumber) {
  try {
    const plan = vendorOrderLearnPlan(party, type, rawOrderNumber);
    if (!plan) return;
    const { name, key } = plan;
    const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    // Drop any stale entry for this order, then push a fresh one — keeps exactly
    // one link per order with an up-to-date `at`, and creates the vendor if new.
    await Vendor.findOneAndUpdate(
      { name: re },
      {
        $setOnInsert: { name, blanksProvided: true },
        $pull: { vendorOrders: { orderNumber: key } },
      },
      { upsert: true },
    );
    await Vendor.findOneAndUpdate(
      { name: re },
      { $push: { vendorOrders: { orderNumber: key, at: new Date() } } },
    );
  } catch (_e) { /* learning is best-effort; never blocks the booking */ }
}

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

// POST /api/receipts/scan — read a receipt with the AI and return SUGGESTED
// transaction fields without saving anything. Powers "attach a receipt while
// adding a finance entry → auto-fill what it can, you review + edit". Purely a
// convenience read: it never creates a Receipt or a Transaction. Returns
// { configured:false } (not an error) when no API key is set, so the caller can
// just fall back to manual entry.
const scan = async (req, res) => {
  try {
    if (!scanner.isConfigured()) return res.json({ configured: false });
    const dataUrl = (req.body && req.body.dataUrl) || '';
    const m = String(dataUrl).match(/^data:([a-z0-9.+/-]+);base64,(.+)$/i);
    if (!m) return res.status(400).json({ message: 'Provide a receipt file (dataUrl).' });
    const { data } = await scanner.extract(Buffer.from(m[2], 'base64'), m[1].toLowerCase());
    const ex = scanner.mapExtracted(data);
    // Order-flow-aware decision. Link by the receipt's order/invoice # → the
    // matching Order (the source of truth for the client), then let
    // decideTransaction set type/party/category/direction:
    //   • our OWN invoice (seller = us) → income · Client Sales · party = the
    //     CLIENT (the Order's company, else the bill-to) — NEVER Joint Printing;
    //   • a supplier receipt → expense · party = the vendor we paid.
    // The party is left BLANK when no client can be determined, for the owner to
    // fill, rather than guessing the company itself (the reported bug).
    const order = await _findLinkedOrder(ex.orderNumber);
    const d = scanner.decideTransaction(ex, order);
    res.json({
      configured: true,
      fields: {
        type:        d.type,
        category:    d.category,
        isCredit:    d.isCredit,
        party:       d.party,
        amount:      ex.amount != null ? ex.amount : '',
        date:        ex.date ? new Date(ex.date).toISOString().slice(0, 10) : '',
        orderNumber: digits(ex.orderNumber),
        description: ex.summary || '',
      },
      // Additive order-link context for the modal (ignored by older clients): when
      // the order# matched an Order, the client/project the prefill was enriched from.
      link: order
        ? { orderNumber: normalizeOrderNumber(order.orderNumber), client: (order.companyName || order.clientName || '').trim(), projectNumber: order.projectNumber || '' }
        : null,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
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
    // Direction (isCredit) is OWNER-CONFIRMED whenever the owner says so, and only
    // falls back to the scan otherwise. Precedence:
    //   1. an explicit isCredit boolean from the owner — accepted whether the
    //      review UI posts it top-level (body.isCredit) OR nested with the other
    //      corrected fields (body.extracted.isCredit). Owner's call, never silently
    //      overridden by the AI read (the audit's flip risk);
    //   2. else the (corrected) extracted kind === 'refund'.
    // Default is a normal expense charge; a refund/credit must be asserted. This
    // means a confirmed charge can't be flipped to a credit (or vice-versa) by a
    // stale AI 'kind' field, which is what was corrupting COGS totals.
    const ownerIsCredit = typeof req.body.isCredit === 'boolean'
      ? req.body.isCredit
      : (req.body.extracted && typeof req.body.extracted.isCredit === 'boolean'
        ? req.body.extracted.isCredit
        : null);

    // Order-flow-aware defaults: link by order# → the Order (source of truth for the
    // client), then decide type/category/party/direction. Our OWN invoice books as
    // income/Client Sales with the CLIENT as party (never Joint Printing); a
    // supplier receipt books as an expense with the vendor as party. The OWNER's
    // explicit corrections still win over the read — confirm is the owner's final
    // say — so an edited type/party/category/isCredit is honored verbatim.
    const order = await _findLinkedOrder(orderNumber);
    const decided = scanner.decideTransaction(e, order);
    const ownerType = req.body.extracted && req.body.extracted.type;
    const type = ownerType === 'income' || ownerType === 'expense' ? ownerType : decided.type;
    const category = (req.body.extracted && req.body.extracted.category) || decided.category;
    // party: owner's explicit correction wins; else the order-flow decision (which
    // never yields the company itself). A blank correction is honored (the owner
    // clearing it), but the company itself is NEVER booked as the party even if
    // posted — that is exactly the bug this guards. Falls back to '' over a guess.
    const ownerParty = req.body.extracted && req.body.extracted.party;
    const party = (typeof ownerParty === 'string' && (ownerParty.trim() === '' || !isSelf(ownerParty)))
      ? ownerParty
      : decided.party;
    const isCredit = ownerIsCredit != null ? ownerIsCredit : decided.isCredit;

    // Duplicate guard: a same-type, same-amount entry with the same order # (or
    // counter-party) is very likely already in the ledger. For income the party is
    // the client; for expense it's the vendor — so the no-order# fallback matches on
    // whoever the counter-party actually is (not the self-seller). When there's
    // NEITHER an order# NOR a party (a valid blank-party income the owner will fill),
    // we skip the probe entirely — otherwise every blank-party row of the same amount
    // would falsely collide and block a genuinely distinct sale.
    if (!req.body.force && (orderNumber || party)) {
      const dupQ = { type, amount, _id: { $exists: true } };
      if (orderNumber) dupQ.orderNumber = orderNumber; else dupQ.party = party;
      const dup = await Transaction.findOne(dupQ).lean();
      if (dup && String(dup._id) !== String(rec.transactionId || '')) {
        return res.status(409).json({
          message: `A matching ${type} is already in the ledger.`,
          duplicate: { id: dup._id, date: dup.date, party: dup.party, amount: dup.amount, category: dup.category, orderNumber: dup.orderNumber },
        });
      }
    }

    const fields = {
      date, type, category, orderNumber, isCredit,
      party, description: e.summary || '', amount,
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

    // Remember which printer did this order (conservative hint) so a future PO/
    // receipt for it can pre-fill the vendor, and the vendor card shows the link.
    await _learnVendorOrder(party, type, orderNumber);

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
    const receipts = await Receipt.find({ status: 'review' }).lean();
    const txns = await Transaction.find({
      type: 'expense', $or: [{ receiptUrl: '' }, { receiptUrl: { $exists: false } }],
    }).lean();
    const within = (a, b, days) => a && b && Math.abs(new Date(a) - new Date(b)) <= days * 86400000;
    const usedTxn = new Set();
    let linked = 0; let unmatched = 0;
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
      } else { unmatched++; }
    }
    res.json({ linked, unmatched });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// POST /api/receipts/reset — undo the receipt booking entirely: delete every
// ledger entry that came FROM a receipt (source:'receipt'), detach receipt files
// from the imported ledger rows, and clear all receipts. Restores the validated
// spreadsheet ledger exactly (source:'import'/'manual'/'order:auto' untouched).
const resetReceipts = async (req, res) => {
  try {
    const delTxn = await Transaction.deleteMany({ source: 'receipt' });
    await Transaction.updateMany({ receiptUrl: { $nin: ['', null] } }, { $set: { receiptUrl: '' } });
    const recs = await Receipt.find({}).select('fileUrl').lean();
    await Promise.all(recs.map((r) => r2.deleteByUrl(r.fileUrl).catch(() => {})));
    const delRec = await Receipt.deleteMany({});
    res.json({ deletedTransactions: delTxn.deletedCount || 0, deletedReceipts: delRec.deletedCount || 0 });
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

// POST /api/receipts/archive-rest — everything in review is already SAVED (file
// + data); this just clears the nag by marking the unlinked ones as kept-as-
// backup, so the review count goes to zero. They stay fully searchable.
const archiveRest = async (req, res) => {
  try {
    const r = await Receipt.updateMany({ status: 'review' }, { $set: { status: 'ignored' } });
    res.json({ archived: r.modifiedCount || 0 });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

module.exports = { upload, scan, batch, list, getOne, reprocess, update, confirm, remove, reconcile, bulkReconcile, clearAll, resetReceipts, archiveRest };
// Pure receipt→vendor learning decision (no DB) — exported for unit tests.
module.exports.vendorOrderLearnPlan = vendorOrderLearnPlan;
