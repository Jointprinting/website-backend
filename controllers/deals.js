// controllers/deals.js
//
// The deal pipeline API. A deal is one opportunity for a business (companyKey);
// a business has many. Endpoints: CRUD, Win/Lose, and the reversible one-time
// "set up deals from my existing orders" migration (dry-run → run → undo).
//
// SAFETY: the migration only INSERTS Deal docs (never touches Orders or Clients),
// and stamps each with origin:'migration' + a batch id — so "undo" is a scoped
// delete of that batch, which restores the exact prior state. Admin-only
// (requireAdmin in routes/dealRoutes.js).

const crypto = require('crypto');
const Deal = require('../models/Deal');
const Order = require('../models/Order');
const Client = require('../models/Client');
const { planMigration } = require('../services/dealService');
const { nextNumber, peekNumber, bumpCounterTo } = require('../utils/sequence');

// Whitelist a create/update body → { set } | { error }. PURE-ish (no DB).
function sanitizeDeal(body = {}, { create = false } = {}) {
  const set = {};
  if (body.companyKey != null) set.companyKey = String(body.companyKey).trim();
  if (body.companyName != null) set.companyName = String(body.companyName).trim().slice(0, 200);
  if (body.title != null) set.title = String(body.title).trim().slice(0, 200);
  if (body.stage != null) {
    if (!Deal.DEAL_STAGES.includes(body.stage)) return { error: `stage must be one of ${Deal.DEAL_STAGES.join(', ')}` };
    set.stage = body.stage;
  }
  if (body.value != null) set.value = Math.max(0, Number(body.value) || 0);
  if (body.notes != null) set.notes = String(body.notes).slice(0, 4000);
  if (body.orderNumber != null) set.orderNumber = String(body.orderNumber).trim().slice(0, 40);
  if (body.projectNumber != null) set.projectNumber = String(body.projectNumber).trim().slice(0, 40);
  if (body.lostReason != null) set.lostReason = String(body.lostReason).slice(0, 500);
  if (create && !set.companyKey) return { error: 'companyKey is required' };
  return { set };
}

// GET /api/deals?companyKey=...&includeArchived=  — the board / a company's deals.
async function listDeals(req, res) {
  try {
    const q = {};
    if (req.query.companyKey) q.companyKey = String(req.query.companyKey).trim();
    if (!req.query.includeArchived) q.archived = { $ne: true };
    const deals = await Deal.find(q).sort({ updatedAt: -1 }).lean();
    res.json({ deals });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// POST /api/deals { companyKey, companyName?, title?, value?, stage? }
async function createDeal(req, res) {
  try {
    const { set, error } = sanitizeDeal(req.body || {}, { create: true });
    if (error) return res.status(400).json({ message: error });
    // Denormalize the company name from the Client if the caller didn't supply it.
    if (!set.companyName) {
      const c = await Client.findOne({ companyKey: set.companyKey }).select('companyName clientName').lean();
      if (c) set.companyName = c.companyName || c.clientName || '';
    }
    set.dealNumber = `D-${await nextNumber('deal')}`;
    set.origin = 'manual';
    const deal = await Deal.create(set);
    res.status(201).json({ deal: deal.toObject() });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// PUT /api/deals/:id — whitelisted patch.
async function updateDeal(req, res) {
  try {
    const { set, error } = sanitizeDeal(req.body || {});
    if (error) return res.status(400).json({ message: error });
    if (!Object.keys(set).length) return res.status(400).json({ message: 'nothing to update' });
    // Load + save (not findOneAndUpdate) so the stage/timestamp pre-save hook runs.
    const deal = await Deal.findById(req.params.id);
    if (!deal) return res.status(404).json({ message: 'deal not found' });
    Object.assign(deal, set);
    await deal.save();
    res.json({ deal: deal.toObject() });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/deals/:id/win  — close the deal won (first win → business is a client,
// derived on read). POST /api/deals/:id/lose { reason } — close it lost.
function setDealOutcome(stage) {
  return async function (req, res) {
    try {
      const deal = await Deal.findById(req.params.id);
      if (!deal) return res.status(404).json({ message: 'deal not found' });
      deal.stage = stage;
      if (stage === 'lost' && req.body && req.body.reason != null) {
        deal.lostReason = String(req.body.reason).slice(0, 500);
      }
      await deal.save();   // hook stamps wonAt/lostAt
      res.json({ deal: deal.toObject() });
    } catch (e) {
      res.status(400).json({ message: e.message });
    }
  };
}

// DELETE /api/deals/:id — soft-archive (never hard-deleted from normal use).
async function deleteDeal(req, res) {
  try {
    const deal = await Deal.findByIdAndUpdate(
      req.params.id,
      { $set: { archived: true, archivedAt: new Date(), archivedReason: 'manual' } },
      { new: true },
    ).lean();
    if (!deal) return res.status(404).json({ message: 'deal not found' });
    res.json({ ok: true, deal });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/deals/start-job { companyKey, title?, value?, reuse? }
// The CRM's one-tap "Start new job": mints the project AND its deal card in one
// go, then the frontend drops the owner straight into the project to build
// mockups/quote. By default it always starts a FRESH project (a repeat client's
// in-flight delivery must never be hijacked); pass reuse:true to attach to the
// company's live project instead (the classic lead handoff behavior).
async function startJob(req, res) {
  try {
    const body = req.body || {};
    const companyKey = String(body.companyKey || '').trim();
    if (!companyKey) return res.status(400).json({ message: 'companyKey is required' });
    const c = await Client.findOne({ companyKey }).select('companyName clientName').lean();
    const { ensureProjectForCompany, ensureDealForProject } = require('./orders');
    const { order, created } = await ensureProjectForCompany({
      companyKey,
      companyName: String(body.companyName || (c && c.companyName) || '').trim(),
      clientName: String((c && c.clientName) || '').trim(),
      dealValue: Number(body.value) || 0,
    }, { forceNew: !body.reuse });
    const deal = await ensureDealForProject(order, {
      title: String(body.title || '').trim().slice(0, 200),
      value: Number(body.value) || 0,
    });
    res.status(created ? 201 : 200).json({ deal, order, created });
  } catch (e) {
    res.status(e.status || 500).json({ message: e.message });
  }
}

// Idempotent boot cutover (server.js): fold the retired 4-stage pipeline onto
// the 5-stage one — qualifying → details_needed, quoted → quoting ('quoting',
// NOT 'quote_sent': a built-but-never-sent quote must not read as sent; the
// approval-share hook promotes it when the link really goes out). updateMany
// bypasses enum validation, and archived deals migrate too (a restore must
// come back with a valid stage). Without this, ANY edit of an old deal would
// throw on the whole-doc revalidation in updateDeal's load+save.
async function migrateDealStages() {
  const a = await Deal.updateMany({ stage: 'qualifying' }, { $set: { stage: 'details_needed' } });
  const b = await Deal.updateMany({ stage: 'quoted' }, { $set: { stage: 'quoting' } });
  const n = (a.modifiedCount || 0) + (b.modifiedCount || 0);
  return n;
}

// ── Reversible migration ──────────────────────────────────────────────────────

// Load the plan inputs once (lean, additive read — nothing is mutated here).
async function _migrationInputs() {
  const [orders, clients, existingDeals] = await Promise.all([
    Order.find({ archived: { $ne: true } })
      .select('_id companyKey companyName clientName status totalValue agentId orderNumber projectNumber orderDate updatedAt').lean(),
    Client.find({ archived: { $ne: true } })
      .select('companyKey companyName clientName stage dealValue agentId updatedAt').lean(),
    Deal.find({}).select('sourceOrderId companyKey stage').lean(),
  ]);
  return { orders, clients, existingDeals };
}

// POST /api/deals/migrate { dryRun }
// dryRun (or ?dryRun=1): PREVIEW only — reports what it would create, writes nothing.
// Otherwise: creates the planned deals, stamped with a fresh batch id (returned so
// the UI can offer a one-click undo). Idempotent — running twice creates nothing new.
async function migrateFromOrders(req, res) {
  try {
    const dryRun = !!(req.body && (req.body.dryRun === true || req.body.dryRun === 'true')) || req.query.dryRun === '1';
    const { orders, clients, existingDeals } = await _migrationInputs();

    if (dryRun) {
      const { toCreate, skippedOrders, skippedWonCompanies } = planMigration({ orders, clients, existingDeals, batchId: '(preview)' });
      return res.json({
        dryRun: true,
        wouldCreate: toCreate.length,
        skippedOrders, skippedWonCompanies,
        sample: toCreate.slice(0, 6).map(d => ({ companyName: d.companyName, title: d.title, stage: d.stage, value: d.value })),
        existingDeals: existingDeals.length,
      });
    }

    const batchId = `mig-${crypto.randomBytes(6).toString('hex')}`;
    const { toCreate, skippedOrders, skippedWonCompanies } = planMigration({ orders, clients, existingDeals, batchId });
    if (toCreate.length === 0) {
      return res.json({ ok: true, created: 0, batchId: null, skippedOrders, skippedWonCompanies, message: 'Already up to date — nothing new to create.' });
    }

    // Assign sequential deal numbers in ONE counter round-trip pair (not one per
    // deal): claim a starting number, number the batch, then bump the counter past
    // it so future manual deals continue cleanly.
    const start = await peekNumber('deal');
    toCreate.forEach((d, i) => { d.dealNumber = `D-${start + i}`; });
    await bumpCounterTo('deal', start + toCreate.length - 1);

    const created = await Deal.insertMany(toCreate, { ordered: false });
    res.json({ ok: true, created: created.length, batchId, skippedOrders, skippedWonCompanies });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// POST /api/deals/migrate/rollback { batchId }  — UNDO a migration run: hard-delete
// ONLY the deals that run created (origin:'migration' + that batch). Orders/Clients
// were never touched, so this fully restores the prior state.
async function rollbackMigration(req, res) {
  try {
    const batchId = String((req.body && req.body.batchId) || '').trim();
    if (!batchId) return res.status(400).json({ message: 'batchId is required' });
    const r = await Deal.deleteMany({ origin: 'migration', migrationBatch: batchId });
    res.json({ ok: true, deleted: r.deletedCount != null ? r.deletedCount : (r.n || 0), batchId });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// GET /api/deals/migrate/status — has the migration been run? (so the UI can show
// "set up" vs "undo"). Lists the migration batches present.
async function migrationStatus(_req, res) {
  try {
    const [total, migrated] = await Promise.all([
      Deal.countDocuments({ archived: { $ne: true } }),
      Deal.find({ origin: 'migration' }).select('migrationBatch createdAt').lean(),
    ]);
    const batchMap = new Map();
    migrated.forEach((d) => {
      const b = d.migrationBatch || '';
      if (!b) return;
      const e = batchMap.get(b) || { batchId: b, count: 0, at: d.createdAt };
      e.count += 1;
      if (d.createdAt && (!e.at || d.createdAt < e.at)) e.at = d.createdAt;
      batchMap.set(b, e);
    });
    res.json({ totalDeals: total, migratedDeals: migrated.length, batches: [...batchMap.values()] });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

module.exports = {
  listDeals, createDeal, updateDeal, deleteDeal,
  winDeal: setDealOutcome('won'),
  loseDeal: setDealOutcome('lost'),
  migrateFromOrders, rollbackMigration, migrationStatus,
  startJob, migrateDealStages,
  // pure helper (unit-tested)
  sanitizeDeal,
};
