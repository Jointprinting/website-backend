// controllers/dataCleanup.js
//
// Admin-only endpoints for the owner-run "Fix data" cleanup — thin wrappers around
// the pure detections in services/dataCleanup.js. They load the live data, build the
// plan, and (only on an explicit confirm) apply field-level fixes with a reversible
// snapshot. Nothing is hard-deleted; every change is undoable by batchId.
//
//   GET/POST /api/crm/data-cleanup/preview  → the plan (no writes; dryRun)
//   POST     /api/crm/data-cleanup/apply     → execute (requires { confirm: true })
//   POST     /api/crm/data-cleanup/revert     → undo a batch by id
//   GET      /api/crm/data-cleanup/status     → how many issues remain (auto-hide the entry at 0)
//
// SAFETY: never re-keys a record (companyKey is unique — collisions are impossible);
// only fixes display names, derives missing keys, and re-points owner-chosen receipts.
// Consolidating an actual duplicate company stays with the tested "Clean up" merge.

const crypto = require('crypto');

const Order = require('../models/Order');
const Client = require('../models/Client');
const Transaction = require('../models/Transaction');
const DataCleanupBatch = require('../models/DataCleanupBatch');
const {
  normalizeOrderNumber, detectOrphanOrders, detectPollutedClients, detectMisKeyedReceipts,
} = require('../services/dataCleanup');

// Only flag a mis-keyed receipt that was ENTERED recently. The owner's historical
// unlinked rows (budget-imported under his unreliable manual order #s) are expected
// to never match an order and aren't worth chasing — "ignore them; only future ones
// matter." A genuinely mis-keyed NEW receipt has a recent createdAt, so it still gets
// caught (and an active order missing its receipt is also surfaced by Needs-receipts).
const MISKEYED_RECENT_DAYS = 45;

// Load the live data the detections diff against (lean; writes target rows by _id).
async function buildPlan() {
  const cutoff = new Date(Date.now() - MISKEYED_RECENT_DAYS * 24 * 60 * 60 * 1000);
  const [orders, clients, txns] = await Promise.all([
    Order.find({}).select('orderNumber companyKey companyName clientName').lean(),
    Client.find({ archived: { $ne: true } }).select('companyKey companyName clientName archived').lean(),
    Transaction.find({ type: 'expense', orderNumber: { $ne: '' }, createdAt: { $gte: cutoff } })
      .select('orderNumber party amount category date type').lean(),
  ]);
  const orderKeys = new Set(orders.map((o) => normalizeOrderNumber(o.orderNumber)).filter(Boolean));
  return {
    orders,
    orphans: detectOrphanOrders(orders),
    polluted: detectPollutedClients(clients),
    misKeyed: detectMisKeyedReceipts(txns, orderKeys),
  };
}

// ── GET/POST /preview ─────────────────────────────────────────────────────────
async function cleanupPreview(req, res) {
  try {
    const { orphans, polluted, misKeyed, orders } = await buildPlan();
    // The real orders the owner can re-point a mis-keyed receipt to (newest first).
    const orderOptions = orders
      .filter((o) => String(o.orderNumber || '').trim())
      .map((o) => ({ orderNumber: o.orderNumber, company: o.companyName || o.clientName || '' }))
      .sort((a, b) => (Number(normalizeOrderNumber(b.orderNumber)) || 0) - (Number(normalizeOrderNumber(a.orderNumber)) || 0));
    res.json({
      dryRun: true,
      counts: { orphans: orphans.length, polluted: polluted.length, misKeyed: misKeyed.length,
        total: orphans.length + polluted.length + misKeyed.length },
      orphans, polluted, misKeyed, orderOptions,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// ── POST /apply ───────────────────────────────────────────────────────────────
// Body: { confirm:true, orphanIds?:[id], clientIds?:[id], receipts?:[{txnId, orderNumber}] }.
// Omitting orphanIds/clientIds applies ALL detected ones of that type; receipts are
// only re-pointed for rows the owner gave a target for.
async function cleanupApply(req, res) {
  try {
    const body = req.body || {};
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to apply without an explicit { confirm: true }. Run the preview first.' });
    }
    const { orphans, polluted } = await buildPlan();
    const orphanWant = Array.isArray(body.orphanIds) ? new Set(body.orphanIds.map(String)) : null;
    const nameWant = Array.isArray(body.clientIds) ? new Set(body.clientIds.map(String)) : null;
    const receiptFixes = Array.isArray(body.receipts) ? body.receipts : [];

    const batchId = `datacleanup-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
    const snap = { orders: [], clients: [], transactions: [] };

    // 1) Orphan orders → derive + set companyKey.
    const orphansToFix = orphanWant ? orphans.filter((o) => orphanWant.has(o.orderId)) : orphans;
    for (const o of orphansToFix) {
      const cur = await Order.findById(o.orderId).select('companyKey').lean();
      if (!cur) continue;
      snap.orders.push({ id: o.orderId, before: { companyKey: cur.companyKey || '' } });
      await Order.updateOne({ _id: o.orderId }, { $set: { companyKey: o.derivedKey } });
    }

    // 2) Contact-polluted names → split the company/contact on the client AND on its
    //    orders (which link by companyKey). The key is NOT changed (it's unique).
    const namesToFix = nameWant ? polluted.filter((c) => nameWant.has(c.clientId)) : polluted;
    for (const c of namesToFix) {
      const cur = await Client.findById(c.clientId).select('companyName clientName companyKey').lean();
      if (!cur) continue;
      snap.clients.push({ id: c.clientId, before: { companyName: cur.companyName || '', clientName: cur.clientName || '' } });
      await Client.updateOne({ _id: c.clientId }, { $set: { companyName: c.cleanCompany, clientName: c.contact } });
      if (cur.companyKey) {
        const ords = await Order.find({ companyKey: cur.companyKey }).select('companyName clientName').lean();
        for (const od of ords) {
          snap.orders.push({ id: String(od._id), before: { companyName: od.companyName || '', clientName: od.clientName || '' } });
          await Order.updateOne({ _id: od._id }, { $set: { companyName: c.cleanCompany, clientName: c.contact } });
        }
      }
    }

    // 3) Mis-keyed receipts → re-point to the owner-chosen order #.
    for (const r of receiptFixes) {
      const target = normalizeOrderNumber(r && r.orderNumber);
      if (!r || !r.txnId || !target) continue;
      const cur = await Transaction.findById(r.txnId).select('orderNumber').lean();
      if (!cur) continue;
      snap.transactions.push({ id: String(r.txnId), before: { orderNumber: cur.orderNumber || '' } });
      await Transaction.updateOne({ _id: r.txnId }, { $set: { orderNumber: target } });
    }

    await DataCleanupBatch.create({
      batchId, status: 'applied', ...snap,
      counts: { orders: snap.orders.length, clients: snap.clients.length, transactions: snap.transactions.length },
    });
    res.json({ applied: true, batchId, fixed: { orders: snap.orders.length, names: snap.clients.length, receipts: snap.transactions.length } });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// ── POST /revert ──────────────────────────────────────────────────────────────
async function cleanupRevert(req, res) {
  try {
    const body = req.body || {};
    if (!body.batchId) return res.status(400).json({ message: 'Provide the { batchId } to revert.' });
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to revert without an explicit { confirm: true }.' });
    }
    const batch = await DataCleanupBatch.findOne({ batchId: body.batchId });
    if (!batch) return res.status(404).json({ message: `No data-cleanup batch found for "${body.batchId}".` });
    if (batch.status === 'reverted') return res.json({ reverted: true, batchId: body.batchId, alreadyReverted: true });

    let restored = 0;
    for (const s of (batch.orders || [])) { if (s && s.id) { await Order.updateOne({ _id: s.id }, { $set: s.before || {} }); restored += 1; } }
    for (const s of (batch.clients || [])) { if (s && s.id) { await Client.updateOne({ _id: s.id }, { $set: s.before || {} }); restored += 1; } }
    for (const s of (batch.transactions || [])) { if (s && s.id) { await Transaction.updateOne({ _id: s.id }, { $set: s.before || {} }); restored += 1; } }

    batch.status = 'reverted';
    await batch.save();
    res.json({ reverted: true, batchId: body.batchId, restored });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// ── GET /status ───────────────────────────────────────────────────────────────
// How many issues remain — the UI shows the "Fix data" entry only when total > 0.
async function cleanupStatus(req, res) {
  try {
    const { orphans, polluted, misKeyed } = await buildPlan();
    res.json({
      total: orphans.length + polluted.length + misKeyed.length,
      orphans: orphans.length, polluted: polluted.length, misKeyed: misKeyed.length,
    });
  } catch (e) { res.json({ total: 0, error: e.message }); }
}

module.exports = { cleanupPreview, cleanupApply, cleanupRevert, cleanupStatus, buildPlan };
