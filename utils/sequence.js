// Atomic project / invoice / purchase-order number assignment.
//
// nextNumber('project' | 'invoice' | 'po', scope?) claims the next number with
// a single $inc, seeding the counter from the current max on first use.
// bumpCounterTo() keeps the counter ahead of any number an admin typed in by
// hand, so an auto-assigned number can never collide with a manual one.
//
// POs are numbered PER VENDOR: pass the vendor name as `scope` and each printer
// gets its own independent sequence (Heritage #009 next, a brand-new printer
// starts at #001). The counter _id becomes "po:<vendor-slug>"; an empty scope
// falls back to the shared 'po' counter so a vendorless draft still gets a
// number. project/invoice never pass a scope, so their behavior is unchanged.

const Counter = require('../models/Counter');

const FIELD = { project: 'projectNumber', invoice: 'orderNumber' };

// Numeric prefix of a stored number ("22-1" → 22, "135" → 135, "#007" → 7).
const numOf = (v) => parseInt(String(v || '0').replace(/^#/, '').split('-')[0], 10) || 0;

// Normalize a vendor name so "Heritage", "heritage", and "Heritage  Screen
// Printing" don't fork into separate sequences.
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Counter document id for a kind, optionally scoped (per-vendor PO sequences).
const counterId = (kind, scope) => (scope && slug(scope) ? `${kind}:${slug(scope)}` : kind);

async function _seedFromOrders(kind, scope) {
  // Lazy require to avoid a circular import (Order's hooks don't need us,
  // but controllers require both).
  let max = 0;
  if (kind === 'po') {
    const PurchaseOrder = require('../models/PurchaseOrder');
    const pos = await PurchaseOrder.find({}).select('poNumber vendorName').lean();
    const want = slug(scope);
    // Per-vendor: only count THIS printer's POs so each sequence is
    // independent. No scope → seed from the highest PO number overall.
    max = pos.reduce((m, p) =>
      (!want || slug(p.vendorName) === want) ? Math.max(m, numOf(p.poNumber)) : m, 0);
  } else {
    const Order = require('../models/Order');
    const field = FIELD[kind];
    const all = await Order.find({}).select(field).lean();
    max = all.reduce((m, o) => Math.max(m, numOf(o[field])), 0);
  }
  await Counter.updateOne(
    { _id: counterId(kind, scope) },
    { $setOnInsert: { seq: max } },
    { upsert: true },
  ).catch(() => { /* lost the upsert race — another request seeded it */ });
}

async function nextNumber(kind, scope) {
  const _id = counterId(kind, scope);
  let c = await Counter.findOneAndUpdate(
    { _id },
    { $inc: { seq: 1 } },
    { new: true },
  );
  if (!c) {
    await _seedFromOrders(kind, scope);
    c = await Counter.findOneAndUpdate(
      { _id },
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );
  }
  return String(c.seq);
}

// Call after persisting a manually-supplied number so auto-assignment continues
// from beyond it. For POs, pass the vendor as `scope` so the bump lands on that
// printer's own sequence (e.g. typing Heritage #009 once carries it forward).
async function bumpCounterTo(kind, value, scope) {
  const n = numOf(value);
  if (!n) return;
  await Counter.updateOne(
    { _id: counterId(kind, scope), seq: { $lt: n } },
    { $set: { seq: n } },
  ).catch(() => { /* best-effort */ });
}

module.exports = { nextNumber, bumpCounterTo };
