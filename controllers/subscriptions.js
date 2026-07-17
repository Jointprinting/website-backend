const Subscription = require('../models/Subscription');
const { SUBSCRIPTION_BRAND_KEYS, brandLabel } = require('../utils/brands');

// The recurring-revenue money layer for JP Webworks + JP Atom. CRUD over
// subscriptions plus the MRR/ARR rollup the Finances view reads. The MRR math is
// pure + unit-tested (no DB) so a brand P&L can trust it.

// ── Pure MRR math (exported for tests) ───────────────────────────────────────

// A subscription's contribution to MONTHLY recurring revenue. Only ACTIVE plans
// count; an annual plan is normalized to 1/12 so every brand's MRR is comparable.
function monthlyAmount(sub) {
  if (!sub || sub.status !== 'active') return 0;
  const amt = Number(sub.amount) || 0;
  if (amt <= 0) return 0;
  return sub.cadence === 'annual' ? amt / 12 : amt;
}

// Roll a list of subscriptions up into MRR/ARR totals + a per-brand split and
// active/paused/canceled counts. Pure — takes plain objects.
function summarizeMrr(subs) {
  const byBrand = new Map();
  const ensure = (b) => {
    if (!byBrand.has(b)) byBrand.set(b, { brand: b, label: brandLabel(b) || b, mrr: 0, active: 0, paused: 0, canceled: 0, count: 0 });
    return byBrand.get(b);
  };
  let mrr = 0, active = 0, paused = 0, canceled = 0;
  for (const s of subs || []) {
    const g = ensure(s.brand || 'unknown');
    g.count += 1;
    if (s.status === 'active') {
      g.active += 1; active += 1;
      const m = monthlyAmount(s); g.mrr += m; mrr += m;
    } else if (s.status === 'paused') { g.paused += 1; paused += 1; }
    else if (s.status === 'canceled') { g.canceled += 1; canceled += 1; }
  }
  const brands = [...byBrand.values()].map((g) => ({
    ...g, mrr: +g.mrr.toFixed(2), arr: +(g.mrr * 12).toFixed(2),
  })).sort((a, b) => b.mrr - a.mrr);
  return {
    mrr: +mrr.toFixed(2), arr: +(mrr * 12).toFixed(2),
    active, paused, canceled, count: (subs || []).length,
    byBrand: brands,
  };
}

// Next bill date one cadence period out from a base date. Pure.
function nextBillFrom(base, cadence) {
  const d = new Date(base);
  if (Number.isNaN(d.getTime())) return null;
  if (cadence === 'annual') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

// ── HTTP handlers (admin-only via the route) ─────────────────────────────────

// GET /api/subscriptions?brand=&status=&companyKey=
async function listSubscriptions(req, res) {
  try {
    const q = { archived: { $ne: true } };
    if (req.query.brand)      q.brand = req.query.brand;
    if (req.query.status)     q.status = req.query.status;
    if (req.query.companyKey) q.companyKey = req.query.companyKey;
    const subs = await Subscription.find(q).sort({ status: 1, updatedAt: -1 }).lean();
    res.json({ subscriptions: subs, summary: summarizeMrr(subs) });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// GET /api/subscriptions/summary?brand=  — MRR/ARR rollup over ACTIVE-inclusive set.
async function subscriptionSummary(req, res) {
  try {
    const q = { archived: { $ne: true } };
    if (req.query.brand) q.brand = req.query.brand;
    const subs = await Subscription.find(q).select('brand status amount cadence').lean();
    res.json(summarizeMrr(subs));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// POST /api/subscriptions
async function createSubscription(req, res) {
  try {
    const b = req.body || {};
    if (!b.companyKey) return res.status(400).json({ message: 'companyKey required' });
    if (!SUBSCRIPTION_BRAND_KEYS.includes(b.brand)) {
      return res.status(400).json({ message: `brand must be one of: ${SUBSCRIPTION_BRAND_KEYS.join(', ')}` });
    }
    const cadence = Subscription.CADENCES.includes(b.cadence) ? b.cadence : 'monthly';
    const startedAt = b.startedAt ? new Date(b.startedAt) : new Date();
    const doc = await Subscription.create({
      companyKey:  b.companyKey,
      companyName: b.companyName || '',
      brand:       b.brand,
      plan:        b.plan || '',
      amount:      Math.max(0, Number(b.amount) || 0),
      cadence,
      status:      'active',
      startedAt,
      nextBillDate: b.nextBillDate ? new Date(b.nextBillDate) : nextBillFrom(startedAt, cadence),
      siteId:      b.siteId || null,
      notes:       b.notes || '',
    });
    res.status(201).json(doc);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// Fields a PATCH/PUT may set directly (status changes go through the actions below).
const PATCHABLE = ['companyName', 'plan', 'amount', 'cadence', 'nextBillDate', 'siteId', 'notes'];

// PUT /api/subscriptions/:id
async function updateSubscription(req, res) {
  try {
    const set = {};
    for (const k of PATCHABLE) {
      if (!(k in (req.body || {}))) continue;
      if (k === 'amount') set.amount = Math.max(0, Number(req.body.amount) || 0);
      else if (k === 'cadence') { if (Subscription.CADENCES.includes(req.body.cadence)) set.cadence = req.body.cadence; }
      else if (k === 'nextBillDate') set.nextBillDate = req.body.nextBillDate ? new Date(req.body.nextBillDate) : null;
      else set[k] = req.body[k];
    }
    const doc = await Subscription.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
    if (!doc) return res.status(404).json({ message: 'not found' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// POST /api/subscriptions/:id/status  { status, reason? } — pause / resume / cancel.
async function setStatus(req, res) {
  try {
    const status = (req.body || {}).status;
    if (!Subscription.SUB_STATUSES.includes(status)) {
      return res.status(400).json({ message: `status must be one of: ${Subscription.SUB_STATUSES.join(', ')}` });
    }
    const set = { status };
    if (status === 'paused')   set.pausedAt = new Date();
    if (status === 'canceled') { set.canceledAt = new Date(); set.cancelReason = (req.body.reason || ''); }
    if (status === 'active')   { set.pausedAt = null; set.canceledAt = null; } // resume clears the stamps
    const doc = await Subscription.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
    if (!doc) return res.status(404).json({ message: 'not found' });
    res.json(doc);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// DELETE /api/subscriptions/:id — soft-delete (archive), house rule.
async function deleteSubscription(req, res) {
  try {
    const doc = await Subscription.findByIdAndUpdate(
      req.params.id,
      { $set: { archived: true, archivedAt: new Date(), archivedReason: 'manual' } },
      { new: true },
    );
    if (!doc) return res.status(404).json({ message: 'not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

module.exports = {
  listSubscriptions,
  subscriptionSummary,
  createSubscription,
  updateSubscription,
  setStatus,
  deleteSubscription,
  // pure, exported for tests / reuse
  monthlyAmount,
  summarizeMrr,
  nextBillFrom,
};
