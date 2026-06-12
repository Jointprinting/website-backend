// Atomic project / invoice number assignment.
//
// nextNumber('project' | 'invoice') claims the next number with a single
// $inc, seeding the counter from the current max in Orders on first use.
// bumpCounterTo() keeps the counter ahead of any number an admin typed in
// by hand, so an auto-assigned number can never collide with a manual one.

const Counter = require('../models/Counter');

const FIELD = { project: 'projectNumber', invoice: 'orderNumber' };

// Numeric prefix of a stored number ("22-1" → 22, "135" → 135, "#007" → 7).
const numOf = (v) => parseInt(String(v || '0').replace(/^#/, '').split('-')[0], 10) || 0;

async function _seedFromOrders(kind) {
  // Lazy require to avoid a circular import (Order's hooks don't need us,
  // but controllers require both).
  let all, field;
  if (kind === 'po') {
    const PurchaseOrder = require('../models/PurchaseOrder');
    all = await PurchaseOrder.find({}).select('poNumber').lean();
    field = 'poNumber';
  } else {
    const Order = require('../models/Order');
    field = FIELD[kind];
    all = await Order.find({}).select(field).lean();
  }
  const max = all.reduce((m, o) => Math.max(m, numOf(o[field])), 0);
  await Counter.updateOne(
    { _id: kind },
    { $setOnInsert: { seq: max } },
    { upsert: true },
  ).catch(() => { /* lost the upsert race — another request seeded it */ });
}

async function nextNumber(kind) {
  let c = await Counter.findOneAndUpdate(
    { _id: kind },
    { $inc: { seq: 1 } },
    { new: true },
  );
  if (!c) {
    await _seedFromOrders(kind);
    c = await Counter.findOneAndUpdate(
      { _id: kind },
      { $inc: { seq: 1 } },
      { new: true, upsert: true },
    );
  }
  return String(c.seq);
}

// Call after persisting a manually-supplied number so auto-assignment
// continues from beyond it.
async function bumpCounterTo(kind, value) {
  const n = numOf(value);
  if (!n) return;
  await Counter.updateOne(
    { _id: kind, seq: { $lt: n } },
    { $set: { seq: n } },
  ).catch(() => { /* best-effort */ });
}

module.exports = { nextNumber, bumpCounterTo };
