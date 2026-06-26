// Atomic project / invoice / purchase-order number assignment.
//
// nextNumber('project' | 'invoice' | 'po', scope?, floor?) claims the next number
// with a single $inc, seeding the counter from the current max on first use.
// bumpCounterTo() keeps the counter ahead of any number an admin typed in by
// hand, so an auto-assigned number can never collide with a manual one.
// peekNumber() reports the number that WOULD be assigned next without consuming
// it, so the UI can surface (and the owner can adjust) a vendor's next PO #.
//
// POs are numbered PER VENDOR: pass the vendor name as `scope` and each printer
// gets its own independent sequence (Heritage #009 next, a brand-new printer
// starts at #001). The counter _id becomes "po:<vendor-slug>"; an empty scope
// falls back to the shared 'po' counter so a vendorless draft still gets a
// number. project/invoice never pass a scope, so their behavior is unchanged.
//
// `floor` (PO only) is the OWNER-SET start for a vendor (Vendor.nextPoStart): the
// app's auto-counter can't know the owner's real historical run (e.g. Heritage POs
// up to ~8 in Google Drive), so the assigned number is max(stored counter, floor).
// Heritage with floor=9 yields #009 next even though the app only ever saw #004.

const Counter = require('../models/Counter');
const { vendorKey } = require('./poCost');

const FIELD = { project: 'projectNumber', invoice: 'orderNumber' };

// Numeric prefix of a stored number ("22-1" → 22, "135" → 135, "#007" → 7).
const numOf = (v) => parseInt(String(v || '0').replace(/^#/, '').split('-')[0], 10) || 0;

// The per-vendor numbering scope. We key off the SAME vendorKey (trim + collapse
// whitespace + lowercase) used to GROUP a PO, SKIP a duplicate supplier, and LOOK
// UP the Vendor doc — so the counter identity matches the grouping identity, and a
// PO is NUMBERED on the exact same key it is grouped/looked-up by. (The old slug
// stripped ALL punctuation, which merged distinct vendors like "A&B Printing" and
// "A B Printing" onto one PO sequence even though the rest of the system — and the
// owner — treat them as different printers.) vendorKey already lowercases + trims +
// collapses whitespace; that's a valid, stable Counter._id string as-is.
const slug = (s) => vendorKey(s);

// Counter document id for a kind, optionally scoped (per-vendor PO sequences).
const counterId = (kind, scope) => (scope && slug(scope) ? `${kind}:${slug(scope)}` : kind);

// ── Pure numbering math (no DB) — exported for tests ──────────────────────────
// `floor` is the owner-set start (Vendor.nextPoStart). A non-positive/NaN floor
// means "no owner floor". These pin the single rule the owner-set start enforces:
// the assigned number is the larger of the natural next-up and the owner's start.
const toFloor = (floor) => { const f = parseInt(floor, 10); return Number.isFinite(f) && f > 0 ? f : 0; };
// The number that WOULD be assigned next given the stored counter `seq` and an
// optional owner floor: max(seq + 1, floor). Drives peekNumber + the "next PO #".
const flooredNext = (seq, floor) => Math.max((Number(seq) || 0) + 1, toFloor(floor));
// The counter value AFTER applying a floor (before the $inc) so the next $inc
// yields exactly the floor: max(currentSeq, floor - 1). Never moves backwards.
const flooredSeq = (seq, floor) => { const f = toFloor(floor); return f ? Math.max(Number(seq) || 0, f - 1) : (Number(seq) || 0); };

// The highest number already in use for a kind/scope — the value a fresh counter
// seeds to. Pure read of existing docs (no counter mutation), shared by the seed
// upsert and by peekNumber so both agree on a never-used vendor's starting point.
async function _seedMax(kind, scope) {
  // Lazy require to avoid a circular import (Order's hooks don't need us,
  // but controllers require both).
  if (kind === 'po') {
    const PurchaseOrder = require('../models/PurchaseOrder');
    // Exclude archived POs (e.g. ones a Drive rebuild superseded) so the per-vendor
    // counter seeds from the LIVE run only. The owner-set floor (Vendor.nextPoStart,
    // set by the rebuild to continue the real Drive history) still lifts it.
    const pos = await PurchaseOrder.find({ archived: { $ne: true } }).select('poNumber vendorName').lean();
    const want = slug(scope);
    // Per-vendor: only count THIS printer's POs so each sequence is
    // independent. No scope → seed from the highest PO number overall.
    return pos.reduce((m, p) =>
      (!want || slug(p.vendorName) === want) ? Math.max(m, numOf(p.poNumber)) : m, 0);
  }
  const Order = require('../models/Order');
  const field = FIELD[kind];
  const all = await Order.find({}).select(field).lean();
  return all.reduce((m, o) => Math.max(m, numOf(o[field])), 0);
}

async function _seedFromOrders(kind, scope) {
  const max = await _seedMax(kind, scope);
  await Counter.updateOne(
    { _id: counterId(kind, scope) },
    { $setOnInsert: { seq: max } },
    { upsert: true },
  ).catch(() => { /* lost the upsert race — another request seeded it */ });
}

// Raise the counter so the NEXT $inc yields at least `floor` (i.e. seq ≥ floor-1),
// without ever moving it backwards. No-op when floor ≤ 0. Lets an owner-set start
// (Vendor.nextPoStart) act as the lower bound for the next assigned number while
// the atomic $inc stays the single source of collision-safety.
async function _applyFloor(_id, floor) {
  const f = toFloor(floor);
  if (!f) return;
  await Counter.updateOne(
    { _id, seq: { $lt: f - 1 } },
    { $set: { seq: f - 1 } },        // = flooredSeq for any seq below the floor
    { upsert: true },
  ).catch(() => { /* best-effort floor; the $inc below still assigns a number */ });
}

async function nextNumber(kind, scope, floor) {
  const _id = counterId(kind, scope);
  // Seed-on-first-use BEFORE the floor, so a brand-new counter starts from the
  // real max of existing numbers; the floor then lifts it if the owner set one.
  const existing = await Counter.findOne({ _id }).lean();
  if (!existing) await _seedFromOrders(kind, scope);
  await _applyFloor(_id, floor);
  const c = await Counter.findOneAndUpdate(
    { _id },
    { $inc: { seq: 1 } },
    { new: true, upsert: true },
  );
  return String(c.seq);
}

// The number that WOULD be assigned next (current seq + 1, but never below the
// owner floor), WITHOUT consuming it. Read-only: it does not create or mutate the
// counter, so calling it repeatedly to render "next PO #" is side-effect free. For
// a never-used vendor it derives the seed the same way nextNumber would.
async function peekNumber(kind, scope, floor) {
  const _id = counterId(kind, scope);
  const c = await Counter.findOne({ _id }).lean();
  // Mirror nextNumber's seed logic without persisting: a never-used counter peeks
  // from the in-memory max of existing numbers.
  const seq = c ? (Number(c.seq) || 0) : await _seedMax(kind, scope);
  return flooredNext(seq, floor);
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

module.exports = { nextNumber, bumpCounterTo, peekNumber };
// Pure numbering math, exported for unit tests (no DB).
module.exports._flooredNext = flooredNext;
module.exports._flooredSeq = flooredSeq;
module.exports._numOf = numOf;
module.exports._slug = slug;
module.exports._counterId = counterId;
