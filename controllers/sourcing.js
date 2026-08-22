// controllers/sourcing.js
//
// The DistributorCentral flow, made recordable. See models/SourcingRequest.js
// for why: the owner researches suppliers, collects quotes, picks one — and
// until now only the winner left a trace, and only once a PO was written
// against them. The losing quotes and the reason vanished every time.
//
//   GET   /api/orders/sourcing              → the list (open first)
//   GET   /api/orders/sourcing/preferred    → who won last time, by category
//   POST  /api/orders/sourcing              → start one
//   PATCH /api/orders/sourcing/:id          → edit it / add or update quotes
//   POST  /api/orders/sourcing/:id/decide   → pick the winner
//   POST  /api/orders/sourcing/:id/archive  → put it away (never deleted)

const mongoose = require('mongoose');
const SourcingRequest = require('../models/SourcingRequest');
const Vendor = require('../models/Vendor');
const Order = require('../models/Order');
const { vendorKey } = require('../utils/poCost');

const badId = (id) => !mongoose.Types.ObjectId.isValid(String(id || ''));
const str = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);
const numOrNull = (v) => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// A quote's vendor, canonicalized against the vendor spine.
//
// The key is derived with the SAME utils/poCost.vendorKey the PO builder and the
// Vendor model use. Deriving it any other way is how a vendor forks — and a
// forked Vendor gets its own PO counter, which eventually hands the same PO
// number to the same printer twice.
function cleanQuote(q) {
  const name = str(q && q.vendorName, 160);
  return {
    vendorName: name,
    vendorKey:  str(q && q.vendorKey, 160) || (name ? vendorKey(name) : ''),
    unitCost:     numOrNull(q && q.unitCost),
    setupCost:    numOrNull(q && q.setupCost),
    moq:          numOrNull(q && q.moq),
    leadTimeDays: numOrNull(q && q.leadTimeDays),
    shipping: str(q && q.shipping, 200),
    source:   str(q && q.source, 500),
    declined: !!(q && q.declined),
    notes:    str(q && q.notes, 2000),
    quotedAt: q && q.quotedAt ? new Date(q.quotedAt) : new Date(),
  };
}

const listSourcing = async (req, res) => {
  try {
    const filter = req.query.archived === '1' ? {} : { archived: { $ne: true } };
    if (req.query.status) filter.status = String(req.query.status);
    if (req.query.category) filter.category = String(req.query.category).trim().toLowerCase();
    if (req.query.companyKey) filter.companyKey = String(req.query.companyKey);
    const docs = await SourcingRequest.find(filter)
      .sort({ status: 1, createdAt: -1 })   // 'abandoned' < 'decided' < 'open' is wrong alphabetically…
      .limit(200)
      .lean();
    // …so order deliberately here instead: what is still open needs attention.
    const rank = { open: 0, decided: 1, abandoned: 2 };
    docs.sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3)
      || new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ requests: docs });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/orders/sourcing/preferred?category=rugs
//
// "The winning one saved for future products like that." The most recently
// DECIDED request in a category names the supplier to start from — so the next
// rug job opens with an answer instead of a blank page.
const preferredSupplier = async (req, res) => {
  try {
    const category = String(req.query.category || '').trim().toLowerCase();
    if (!category) return res.status(400).json({ message: 'Which category?' });
    const doc = await SourcingRequest.findOne({
      category, status: 'decided', archived: { $ne: true }, winnerVendorKey: { $ne: '' },
    }).sort({ decidedAt: -1 }).lean();
    if (!doc) return res.json({ preferred: null });
    // The vendor record itself, when there is one — the card, the terms, the
    // lead time. A winner recorded before the vendor was created still returns
    // the name, which is better than nothing.
    const vendor = await Vendor.findOne({ vendorKey: doc.winnerVendorKey, archived: { $ne: true } }).lean();
    res.json({
      preferred: {
        vendorKey: doc.winnerVendorKey,
        vendorName: doc.winnerVendorName,
        decidedAt: doc.decidedAt,
        decisionNote: doc.decisionNote,
        fromRequest: { _id: doc._id, title: doc.title },
        vendor: vendor || null,
      },
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

const createSourcing = async (req, res) => {
  try {
    const b = req.body || {};
    const title = str(b.title, 200);
    if (!title) return res.status(400).json({ message: 'What are you sourcing?' });

    // Anchor to the project when given, and inherit its companyKey so the CRM
    // sees it too — the same pattern preorder links use.
    let companyKey = str(b.companyKey, 160);
    let projectNumber = str(b.projectNumber, 40);
    let orderId = null;
    if (b.orderId && !badId(b.orderId)) {
      const o = await Order.findById(b.orderId).select('projectNumber companyKey').lean();
      if (o) {
        orderId = o._id;
        projectNumber = projectNumber || o.projectNumber || '';
        companyKey = companyKey || o.companyKey || '';
      }
    }

    const doc = await SourcingRequest.create({
      title,
      category: str(b.category, 80),
      companyKey, projectNumber, orderId,
      qtyNeeded:      numOrNull(b.qtyNeeded),
      targetUnitCost: numOrNull(b.targetUnitCost),
      neededBy:       b.neededBy ? new Date(b.neededBy) : null,
      notes: str(b.notes, 4000),
      quotes: Array.isArray(b.quotes) ? b.quotes.map(cleanQuote) : [],
    });
    res.status(201).json({ request: doc.toObject() });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

const updateSourcing = async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ message: 'Not found' });
    const b = req.body || {};
    const doc = await SourcingRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Not found' });

    if ('title' in b) doc.title = str(b.title, 200);
    if ('category' in b) doc.category = str(b.category, 80);
    if ('notes' in b) doc.notes = str(b.notes, 4000);
    if ('qtyNeeded' in b) doc.qtyNeeded = numOrNull(b.qtyNeeded);
    if ('targetUnitCost' in b) doc.targetUnitCost = numOrNull(b.targetUnitCost);
    if ('neededBy' in b) doc.neededBy = b.neededBy ? new Date(b.neededBy) : null;
    // Quotes are replaced wholesale when sent — the editor holds the whole list
    // and this is a single-owner tool, so a merge would only add a way for the
    // two to disagree.
    if (Array.isArray(b.quotes)) doc.quotes = b.quotes.map(cleanQuote);

    await doc.save();
    res.json({ request: doc.toObject() });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

// POST /api/orders/sourcing/:id/decide  { vendorKey | vendorName, note }
//
// Picking the winner is also where the vendor becomes real: if the winning
// supplier has no Vendor record yet — which is the normal case, since they were
// a name on a DistributorCentral listing an hour ago — one is created, marked
// as sourced, carrying what the quote already told us. Otherwise the next step
// (writing them a PO) would mint it by accident with none of that detail.
const decideSourcing = async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ message: 'Not found' });
    const doc = await SourcingRequest.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Not found' });

    const b = req.body || {};
    const wantKey = str(b.vendorKey, 160);
    const wantName = str(b.vendorName, 160);
    if (!wantKey && !wantName) return res.status(400).json({ message: 'Which supplier won?' });

    const key = wantKey || vendorKey(wantName);
    const quote = (doc.quotes || []).find((q) => q.vendorKey === key)
      || (doc.quotes || []).find((q) => vendorKey(q.vendorName || '') === key);
    const name = wantName || (quote && quote.vendorName) || '';

    let vendor = await Vendor.findOne({ vendorKey: key });
    if (!vendor && name) {
      vendor = await Vendor.create({
        name,
        createdVia: 'sourcing',
        // What the quote already told us, rather than an empty card the owner
        // has to re-type from a request he is about to close.
        leadTimeDays: quote && Number(quote.leadTimeDays) > 0 ? Number(quote.leadTimeDays) : 0,
        minOrder:     quote && Number(quote.moq) > 0 ? Number(quote.moq) : 0,
        notes: [
          `Sourced for "${doc.title}"${doc.category ? ` (${doc.category})` : ''}.`,
          quote && Number(quote.unitCost) > 0 ? `Quoted $${Number(quote.unitCost).toFixed(2)}/unit${Number(quote.setupCost) > 0 ? ` + $${Number(quote.setupCost).toFixed(2)} setup` : ''}.` : '',
          quote && quote.source ? `Source: ${quote.source}` : '',
          str(b.note, 2000),
        ].filter(Boolean).join('\n'),
      });
    }

    doc.status = 'decided';
    doc.winnerVendorKey = key;
    doc.winnerVendorName = name || (vendor && vendor.name) || '';
    doc.decidedAt = new Date();
    doc.decisionNote = str(b.note, 2000);
    await doc.save();

    res.json({ request: doc.toObject(), vendor: vendor ? vendor.toObject() : null });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

const archiveSourcing = async (req, res) => {
  try {
    if (badId(req.params.id)) return res.status(404).json({ message: 'Not found' });
    const doc = await SourcingRequest.findByIdAndUpdate(
      req.params.id,
      { $set: { archived: true, archivedAt: new Date(), status: req.body && req.body.abandoned ? 'abandoned' : undefined } },
      { new: true, omitUndefined: true },
    ).lean();
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json({ ok: true, request: doc });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

module.exports = {
  listSourcing, preferredSupplier, createSourcing, updateSourcing, decideSourcing, archiveSourcing,
  // PURE (no DB) — exported for tests.
  cleanQuote,
};
