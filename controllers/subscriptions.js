const Subscription = require('../models/Subscription');
const Transaction = require('../models/Transaction');
const r2 = require('../services/r2');
const { SUBSCRIPTION_BRAND_KEYS, brandLabel } = require('../utils/brands');

const round2 = (v) => Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;

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

// ── "Record this month's plans" — per-period recording (mirror of the expense
//    tracker, income-side). Pure helpers, exported for tests. ─────────────────

const pad2 = (n) => String(n).padStart(2, '0');

// The billing-period key a date falls in: 'YYYY-MM' monthly, 'YYYY' annual.
function billingPeriodKey(date, cadence) {
  const d = new Date(date);
  return cadence === 'annual'
    ? String(d.getUTCFullYear())
    : `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

// The current-period recording state of ONE subscription as of `today`. Pure.
//   currentPeriod — the period key we'd record right now
//   recorded — an income row is already booked for it
//   settled  — recorded OR explicitly skipped (so it's off the to-do list)
function recordStatusFor(sub, today) {
  const cadence = sub.cadence === 'annual' ? 'annual' : 'monthly';
  const currentPeriod = billingPeriodKey(today, cadence);
  const entry = (sub.periods || []).find((p) => p.period === currentPeriod);
  return {
    currentPeriod,
    recorded: !!(entry && entry.status === 'recorded'),
    settled: !!entry,
  };
}

// The plans still to record for the current period: ACTIVE, started on/before now,
// not yet settled this period. The checklist behind "record this month's plans".
// Pure — returns a light row per due plan.
function dueThisPeriod(subs, today) {
  const now = new Date(today);
  const out = [];
  for (const s of subs || []) {
    if (s.status !== 'active' || s.archived) continue;
    if (s.startedAt && new Date(s.startedAt) > now) continue; // not started yet
    const rs = recordStatusFor(s, now);
    if (rs.settled) continue;
    out.push({
      id: s._id, companyKey: s.companyKey, companyName: s.companyName || '',
      brand: s.brand, plan: s.plan || '', amount: Number(s.amount) || 0,
      cadence: s.cadence || 'monthly', period: rs.currentPeriod, siteId: s.siteId || null,
    });
  }
  return out;
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

// GET /api/subscriptions/summary?brand=  — MRR/ARR rollup over ACTIVE-inclusive set,
// plus `dueThisPeriod`: the active plans not yet recorded for the current period
// (the checklist behind "record this month's plans" on the Finances page).
async function subscriptionSummary(req, res) {
  try {
    const q = { archived: { $ne: true } };
    if (req.query.brand) q.brand = req.query.brand;
    // Need periods/startedAt/companyName for the due list, so select the wider set.
    const subs = await Subscription.find(q)
      .select('brand status amount cadence companyKey companyName plan startedAt siteId periods').lean();
    res.json({ ...summarizeMrr(subs), dueThisPeriod: dueThisPeriod(subs, new Date()) });
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

// POST /api/subscriptions/:id/record — "record this month's plan": book ONE income
// Transaction (brand-tagged, Client Sales, party = the client), optionally storing
// the invoice sent to the client, and mark the period recorded. Idempotent per
// period (updates the row on a re-record instead of stacking). Body:
//   { period?, amount?, date?, fileDataUrl?, fileName?, note? }
async function recordPlan(req, res) {
  try {
    const sub = await Subscription.findById(req.params.id);
    if (!sub) return res.status(404).json({ message: 'not found' });
    const b = req.body || {};
    const rs = recordStatusFor(sub.toObject(), new Date());
    const period = b.period || rs.currentPeriod;
    const amount = round2(b.amount != null ? b.amount : sub.amount);
    if (!(amount > 0)) return res.status(400).json({ message: 'An amount is required to record this plan.' });
    const date = b.date ? new Date(b.date) : new Date();

    // Store the client invoice (best-effort) so the original lives in the archive.
    let receiptUrl = '';
    if (b.fileDataUrl) {
      const m = String(b.fileDataUrl).match(/^data:([a-z0-9.+/-]+);base64,(.+)$/i);
      if (m && r2.isR2Configured()) {
        try { receiptUrl = await r2.uploadBuffer(Buffer.from(m[2], 'base64'), m[1].toLowerCase(), 'receipts'); }
        catch (_e) { /* a storage hiccup must never block booking the revenue */ }
      }
    }

    const existing = (sub.periods || []).find((p) => p.period === period);
    const label = sub.plan || brandLabel(sub.brand) || 'Subscription';
    const txnFields = {
      date, type: 'income', category: 'Client Sales',
      party: sub.companyName || '', brand: sub.brand || '',
      description: `${label} — ${period}${sub.companyName ? ` · ${sub.companyName}` : ''}`,
      amount, source: 'subscription',
      receiptUrl: receiptUrl || (existing && existing.receiptUrl) || '',
    };
    let txn;
    if (existing && existing.transactionId) {
      txn = await Transaction.findByIdAndUpdate(existing.transactionId, txnFields, { new: true });
    }
    if (!txn) txn = await Transaction.create(txnFields);

    const entry = {
      period, status: 'recorded', amount, recordedAt: new Date(),
      receiptUrl: txnFields.receiptUrl, transactionId: txn._id, note: b.note || '',
    };
    sub.periods = [...(sub.periods || []).filter((p) => p.period !== period), entry];
    await sub.save();
    res.json({ subscription: sub, transaction: txn, period });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// POST /api/subscriptions/:id/skip — this period wasn't billed (comped/paused that
// month). Marks it settled-as-skipped so it drops off the to-record list, no income
// booked. Body { period? }.
async function skipPlan(req, res) {
  try {
    const sub = await Subscription.findById(req.params.id);
    if (!sub) return res.status(404).json({ message: 'not found' });
    const rs = recordStatusFor(sub.toObject(), new Date());
    const period = (req.body && req.body.period) || rs.currentPeriod;
    sub.periods = [
      ...(sub.periods || []).filter((p) => p.period !== period),
      { period, status: 'skipped', amount: null, recordedAt: new Date(), note: (req.body && req.body.note) || '' },
    ];
    await sub.save();
    res.json({ subscription: sub, period });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// POST /api/subscriptions/:id/unrecord — undo a recorded period: remove the entry
// (so it can be recorded again) and soft-delete the booked income row. Body { period }.
async function unrecordPlan(req, res) {
  try {
    const sub = await Subscription.findById(req.params.id);
    if (!sub) return res.status(404).json({ message: 'not found' });
    const period = req.body && req.body.period;
    if (!period) return res.status(400).json({ message: 'period required' });
    const entry = (sub.periods || []).find((p) => p.period === period);
    if (entry && entry.transactionId) {
      await Transaction.findByIdAndUpdate(entry.transactionId, { $set: { archived: true, archivedAt: new Date() } });
    }
    sub.periods = (sub.periods || []).filter((p) => p.period !== period);
    await sub.save();
    res.json({ subscription: sub, period });
  } catch (e) { res.status(400).json({ message: e.message }); }
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
  recordPlan,
  skipPlan,
  unrecordPlan,
  // pure, exported for tests / reuse
  monthlyAmount,
  summarizeMrr,
  nextBillFrom,
  billingPeriodKey,
  recordStatusFor,
  dueThisPeriod,
};
