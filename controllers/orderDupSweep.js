// controllers/orderDupSweep.js
//
// Owner-triggered "find & archive DUPLICATE orders" — the same job that exists
// twice: a real project order (quote lines / project #) AND a bare QuickBooks/
// Notion invoice import (importedFrom 'notion', just an amount) for the same
// company + amount. The existing order-renumber reconcile (orderReconcile.js)
// folds scattered NUMBERS; this archives the redundant RECORD so it stops
// double-counting every accrual/company stat. Thin wrapper over the pure,
// unit-tested services/orderDedup.js.
//
//   GET/POST /api/orders/dedup/preview  → the plan (NO writes; dryRun)
//   POST     /api/orders/dedup/apply    → archive the duplicates (requires confirm)
//   POST     /api/orders/dedup/revert   → un-archive a prior batch (by id)
//
// SAFETY: archive, NEVER hard-delete. Every touched order is stamped with
// reconcileBatchId so the run reverts as a unit. Idempotent (a re-apply is a
// no-op — archived orders drop out of the active set). Conservative matching (see
// services/orderDedup.js): only a clear project↔bare-import pair on the same
// company + amount + close date is ever proposed; ambiguous groups are left alone.

const crypto = require('crypto');
const Order = require('../models/Order');
const { planOrderDedup } = require('../services/orderDedup');

// Active orders the plan reads — slim projection: enough for isProjectOrder /
// isBareImport (projectNumber, quoteLines presence, confirmation content, source)
// and the owner-facing report.
const ORDER_FIELDS = 'companyKey companyName clientName orderNumber projectNumber ' +
  'totalValue orderDate status paid importedFrom archived quoteLines ' +
  'confirmation.items confirmation.customLines';

async function loadActiveOrders() {
  return Order.find({ archived: { $ne: true } }).select(ORDER_FIELDS).lean();
}

const slim = (o) => ({
  id: String(o._id), orderNumber: o.orderNumber || '', projectNumber: o.projectNumber || '',
  company: o.companyName || o.clientName || o.companyKey || '',
  totalValue: Number(o.totalValue) || 0, status: o.status || '',
  orderDate: o.orderDate || null, importedFrom: o.importedFrom || '',
});

function groupsFor(orders) {
  return planOrderDedup(orders).groups.map((g) => ({
    companyKey: g.companyKey,
    amount: g.amount,
    keep: g.keep.map(slim),
    archive: g.archive.map(slim),
  }));
}

// ── GET/POST /api/orders/dedup/preview ───────────────────────────────────────
async function dedupPreview(req, res) {
  try {
    const orders = await loadActiveOrders();
    const groups = groupsFor(orders);
    const ordersToArchive = groups.reduce((n, g) => n + g.archive.length, 0);
    res.json({ dryRun: true, duplicateGroups: groups.length, ordersToArchive, groups });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── POST /api/orders/dedup/apply ─────────────────────────────────────────────
async function dedupApply(req, res) {
  try {
    const body = req.body || {};
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to apply without an explicit { confirm: true }. Run the preview first.' });
    }
    const orders = await loadActiveOrders();
    const { toArchive } = planOrderDedup(orders);
    const ids = toArchive.map((o) => o._id);
    if (ids.length === 0) {
      return res.json({ applied: true, archived: 0, batchId: null, note: 'No duplicate orders found.' });
    }
    const batchId = `orderdedup-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`;
    // Archive (soft). Re-assert archived:{$ne:true} in the write filter so a
    // concurrent edit can't be clobbered and idempotency holds.
    const r = await Order.updateMany(
      { _id: { $in: ids }, archived: { $ne: true } },
      { $set: { archived: true, archivedAt: new Date(), archivedReason: 'duplicate', reconcileBatchId: batchId } },
    );
    const archived = r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
    res.json({ applied: true, archived, batchId, note: `Archived ${archived} duplicate order(s). Reversible with this batchId.` });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── POST /api/orders/dedup/revert ────────────────────────────────────────────
async function dedupRevert(req, res) {
  try {
    const body = req.body || {};
    const batchId = body.batchId;
    if (!batchId) return res.status(400).json({ message: 'Provide the { batchId } to revert.' });
    if (body.confirm !== true && body.confirm !== 'true') {
      return res.status(400).json({ message: 'Refusing to revert without an explicit { confirm: true }.' });
    }
    // Only un-archive orders THIS batch archived as duplicates — never touch an
    // order archived for another reason or by another run.
    const r = await Order.updateMany(
      { reconcileBatchId: batchId, archived: true, archivedReason: 'duplicate' },
      { $set: { archived: false, archivedAt: null, archivedReason: '', reconcileBatchId: '' } },
    );
    const restored = r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
    res.json({ reverted: true, batchId, restored, note: `Restored ${restored} order(s).` });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

module.exports = { dedupPreview, dedupApply, dedupRevert };
