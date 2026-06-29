// controllers/orderReconcile.js
//
// Owner-triggered "reconcile an order's scattered numbers" endpoints — the thin HTTP
// layer over services/orderReconcile.js. Loads the live Transactions + Orders, builds
// the plan, and (only on an explicit confirm) folds every reference to one canonical
// order number, REVERSIBLY:
//
//   GET/POST /api/finances/order-reconcile/preview → the plan (no writes)
//   POST     /api/finances/order-reconcile/apply    → renumber (requires { confirm: true })
//   POST     /api/finances/order-reconcile/revert   → undo a batch by id
//   GET      /api/finances/order-reconcile/status    → last applied batch (for the undo affordance)
//
// SAFETY:
//   • Nothing auto-applies — apply requires { confirm: true }.
//   • Before any write, the prior orderNumber of EVERY touched record is snapshotted into
//     an OrderRenumberBatch, so revert restores each number byte-for-byte.
//   • Auto-hiding: once everything reads the canonical number the preview returns count 0,
//     so the UI entry disappears on its own (no lingering clutter).

const crypto = require('crypto');

const Transaction = require('../models/Transaction');
const Order = require('../models/Order');
const OrderRenumberBatch = require('../models/OrderRenumberBatch');
const { buildReconcilePlan } = require('../services/orderReconcile');

// The live rows the plan diffs against — lean, only the fields the pure logic + preview
// need. Writes target records by _id.
async function loadData() {
  const [transactions, orders] = await Promise.all([
    Transaction.find({})
      .select('orderNumber invoiceNumber party description amount type').lean(),
    Order.find({})
      .select('orderNumber companyName clientName companyKey status totalValue archived').lean(),
  ]);
  return { transactions, orders };
}

// ── GET/POST /api/finances/order-reconcile/preview ────────────────────────────
async function preview(req, res) {
  try {
    const { transactions, orders } = await loadData();
    const plan = buildReconcilePlan(transactions, orders, {});
    res.json({ dryRun: true, summary: plan.summary, plans: plan.plans });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── POST /api/finances/order-reconcile/apply ──────────────────────────────────
async function apply(req, res) {
  try {
    const body = req.body || {};
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to renumber without an explicit { confirm: true }. Run the preview first.' });
    }

    const { transactions, orders } = await loadData();
    const plan = buildReconcilePlan(transactions, orders, body.targetKey ? { targetKey: body.targetKey } : {});
    const changes = plan.plans.flatMap((p) => p.changes);
    if (!changes.length) {
      return res.json({ applied: true, count: 0, note: 'Nothing to reconcile — every reference already reads the canonical number.' });
    }

    const batchId = body.batchId || `ordrenum-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
    const first = plan.plans[0];

    // 1) SNAPSHOT the prior number of every record FIRST (durable backup → reversible),
    //    persisted before any mutation so an interruption can't lose the originals.
    await OrderRenumberBatch.create({
      batchId,
      status: 'applied',
      targetKey: plan.plans.length === 1 ? first.target.key : 'multiple',
      label: plan.plans.length === 1 ? first.target.label : `${plan.plans.length} orders`,
      canonical: plan.plans.length === 1 ? first.canonical : '',
      changes: changes.map((c) => ({ collection: c.collection, id: c.id, from: c.from, to: c.to })),
      count: changes.length,
      note: `Reconciled ${plan.summary.txnCount} ledger row(s) + ${plan.summary.orderCount} order doc(s) across ${plan.summary.orders} order(s).`,
    });

    // 2) Renumber each record to its canonical number.
    let txns = 0, ords = 0;
    for (const c of changes) {
      if (c.collection === 'Transaction') {
        await Transaction.findByIdAndUpdate(c.id, { $set: { orderNumber: c.to } }, { new: false });
        txns += 1;
      } else if (c.collection === 'Order') {
        await Order.findByIdAndUpdate(c.id, { $set: { orderNumber: c.to } }, { new: false });
        ords += 1;
      }
    }

    res.json({ applied: true, batchId, count: changes.length, transactions: txns, orders: ords, summary: plan.summary });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── GET /api/finances/order-reconcile/status ──────────────────────────────────
// The most-recent applied (not reverted) batch, so the UI can offer a one-tap undo.
async function status(req, res) {
  try {
    const last = await OrderRenumberBatch.findOne({ status: 'applied' }).sort({ at: -1 })
      .select('batchId at label canonical count').lean();
    res.json({
      lastBatchId: last ? last.batchId : '',
      lastLabel: last ? last.label : '',
      lastCanonical: last ? last.canonical : '',
      lastCount: last ? last.count : 0,
      at: last ? last.at : null,
    });
  } catch (e) {
    res.json({ lastBatchId: '', error: e.message });
  }
}

// ── POST /api/finances/order-reconcile/revert ─────────────────────────────────
// Undo a renumber batch: write each record's orderNumber back to its prior value.
async function revert(req, res) {
  try {
    const body = req.body || {};
    const batchId = body.batchId;
    if (!batchId) return res.status(400).json({ message: 'Provide the { batchId } to revert.' });
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to revert without an explicit { confirm: true }.' });
    }
    const batch = await OrderRenumberBatch.findOne({ batchId });
    if (!batch) return res.status(404).json({ message: `No order-renumber batch found for id "${batchId}".` });
    if (batch.status === 'reverted') {
      return res.json({ reverted: true, batchId, alreadyReverted: true, note: 'This batch was already reverted.' });
    }

    // Guard against an out-of-order revert: undoing an older batch after a newer one
    // could resurrect a number the newer run already changed. Refuse and point at the
    // latest. (Mirrors the dedupe/restart revert guards.)
    const newer = await OrderRenumberBatch.findOne({
      status: 'applied', at: { $gt: batch.at }, batchId: { $ne: batchId },
    }).sort({ at: -1 }).lean();
    if (newer) {
      return res.status(409).json({
        message: `A newer reconcile (batch ${newer.batchId}) ran after this one. Revert that one first.`,
        latestBatchId: newer.batchId,
      });
    }

    let restored = 0;
    for (const c of (batch.changes || [])) {
      const Model = c.collection === 'Order' ? Order : Transaction;
      const r = await Model.findByIdAndUpdate(c.id, { $set: { orderNumber: c.from } }, { new: false });
      if (r) restored += 1;
    }

    batch.status = 'reverted';
    await batch.save();
    res.json({ reverted: true, batchId, restored, note: 'Every record was renumbered back to its prior order number.' });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

module.exports = { preview, apply, status, revert, loadData };
