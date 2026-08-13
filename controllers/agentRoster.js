// controllers/agentRoster.js
//
// The owner's Agent Manager API — the roster, one agent's scorecard, the
// onboarding checklist, and the lifecycle writes (start, pause, depart).
//
// WHY THIS IS A SEPARATE CONTROLLER FROM admin.js
// admin.js owns ACCOUNTS: create a login, reset a password, toggle access. This
// owns the PERSON: where they are in onboarding, what they cost, what they have
// produced, and whether to keep them. Different questions, different read shapes,
// and keeping them apart stops the auth-adjacent code growing a reporting layer.
//
// WHY IT AGGREGATES INSTEAD OF LOOPING
// The old roster read ran computeAgentStats per agent — 1 + 2N queries, each
// pulling that agent's ENTIRE order history to derive one month. At three agents
// that is invisible; at fifty it is a hundred round trips and the whole order
// collection in memory. Every rollup here is ONE grouped pipeline over the
// collection, keyed by agent, so the cost is flat in roster size. That is the
// difference between a Team tab and something that survives a real roster.

const AdminUser = require('../models/AdminUser');
const Order = require('../models/Order');
const Client = require('../models/Client');
const Transaction = require('../models/Transaction');
const { PLACED_STATUSES } = require('../models/Order');
const { checklistFor, gates, impliedStatus, STEP_KEYS } = require('../services/agentLifecycle');
const { scorecard, rosterSummary, survivalLanes } = require('../services/agentAnalytics');
const { normalizeConfig, tierFor, originKind, earnedState, commissionForOrder } = require('../services/commission');

// Money-shaped fields the owner needs but an agent must never receive. This
// controller is behind requireOwner, so this is belt-and-braces, not the gate.
const OWNER_ONLY = true;

// ── shared loader ────────────────────────────────────────────────────────────
//
// Builds every agent's scorecard in a fixed number of queries regardless of how
// many agents there are. Returns { agents, cards, byId }.
async function loadRoster({ includeDeparted = true } = {}) {
  const q = { role: 'agent' };
  if (!includeDeparted) q.status = { $ne: 'departed' };
  const agents = await AdminUser.find(q).sort({ createdAt: -1 }).lean();
  if (!agents.length) return { agents: [], cards: [], byId: {} };

  const ids = agents.map((a) => String(a._id));

  // ONE pass over the orders these agents SOURCED. Keyed on originAgentId, not
  // agentId: commission and credit follow who sold it, and reassigning a book
  // must not move a departed rep's production onto whoever inherited it.
  const orders = await Order.find({ originAgentId: { $in: ids }, archived: { $ne: true } })
    .select('originAgentId orderNumber companyKey status totalValue cogs orderDate deliveredDate paid createdAt')
    .sort({ orderDate: 1, createdAt: 1 })
    .lean();

  // ONE ledger pass for the orders in play, so per-order profit is the real
  // booked number wherever it exists rather than the quote estimate.
  const nums = [...new Set(orders.map((o) => String(o.orderNumber || '').replace(/[^0-9]/g, '').replace(/^0+/, '')).filter(Boolean))];
  const ledger = {};
  if (nums.length) {
    const spellings = [...new Set(nums.flatMap((n) => [n, n.padStart(6, '0'), n.padStart(7, '0')]))];
    const rows = await Transaction.find({ orderNumber: { $in: spellings } })
      .select('orderNumber type category amount isCredit').lean();
    for (const t of rows) {
      const k = String(t.orderNumber || '').replace(/[^0-9]/g, '').replace(/^0+/, '');
      if (k) (ledger[k] ||= []).push(t);
    }
  }

  // ONE grouped count of each agent's CRM book (how many companies they hold).
  const leadCounts = await Client.aggregate([
    { $match: { originAgentId: { $in: ids }, archived: { $ne: true } } },
    { $group: { _id: '$originAgentId', n: { $sum: 1 } } },
  ]);
  const leadsBy = Object.fromEntries(leadCounts.map((r) => [String(r._id), r.n]));

  // Group orders by agent, then walk each agent's chronologically so the
  // commission ladder applies at the tier they actually held at the time —
  // identical to the agent's own Earnings tab.
  const ordersBy = {};
  for (const o of orders) (ordersBy[String(o.originAgentId)] ||= []).push(o);

  const { orderMoney } = require('./agentPortal');
  const now = new Date();

  const cards = agents.map((a) => {
    const uid = String(a._id);
    const cfg = normalizeConfig(a.commission);
    let lifetimeProfit = 0;
    let selfDone = 0;
    const seen = {};
    const priced = (ordersBy[uid] || []).map((o) => {
      const key = String(o.orderNumber || '').replace(/[^0-9]/g, '').replace(/^0+/, '');
      const money = orderMoney(o, ledger[key]);
      const ck = o.companyKey || '';
      const kind = originKind({ sourcedByAgent: true, priorOrdersForCompany: ck ? (seen[ck] || 0) : 0 });
      const state = earnedState(o);
      const calc = commissionForOrder({
        profit: money.profit, kind, lifetimeProfit, selfOrdersCompleted: selfDone, config: cfg, state,
      });
      if (ck) seen[ck] = (seen[ck] || 0) + 1;
      if (state === 'earned') { lifetimeProfit += Math.max(0, money.profit); selfDone += 1; }
      return {
        orderDate: o.orderDate || o.createdAt,
        deliveredDate: o.deliveredDate,
        state,
        revenue: money.revenue,
        profit: money.profit,
        commission: calc.commission,
      };
    });

    const card = scorecard({ agent: a, orders: priced, now });
    card.leads = leadsBy[uid] || 0;
    card.tier = tierFor(lifetimeProfit, cfg);
    card.commissionEnabled = !!cfg.enabled;
    const cl = checklistFor(a);
    card.onboardingProgress = cl.progress;
    card.onboardingComplete = cl.complete;
    card.gates = gates(a);
    return card;
  });

  return { agents, cards, byId: Object.fromEntries(cards.map((c) => [c.id, c])) };
}

// GET /api/admin/agents/roster — the whole Agent Manager payload in one read.
async function roster(req, res) {
  try {
    const { cards } = await loadRoster({ includeDeparted: true });
    res.json({
      agents: cards,
      summary: rosterSummary({ cards }),
      lanes: survivalLanes({ cards }),
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// GET /api/admin/agents/:id/scorecard — one agent, with their checklist.
async function scorecardOne(req, res) {
  try {
    const a = await AdminUser.findOne({ _id: req.params.id, role: 'agent' }).lean();
    if (!a) return res.status(404).json({ message: 'Agent not found.' });
    const { byId } = await loadRoster({ includeDeparted: true });
    res.json({
      agent: {
        id: String(a._id), username: a.username, displayName: a.displayName || '',
        legalName: a.legalName || '', contactEmail: a.contactEmail || '', phone: a.phone || '',
        entityName: a.entityName || '', entityEin: a.entityEin || '', tinLast4: a.tinLast4 || '',
        hasOtherClients: !!a.hasOtherClients,
        recruitSource: a.recruitSource || '', territory: a.territory || '',
        status: a.status || 'onboarding', active: a.active !== false,
        startedSellingAt: a.startedSellingAt || null,
        departedAt: a.departedAt || null, departedKind: a.departedKind || '', departedReason: a.departedReason || '',
        seatCostMonthly: a.seatCostMonthly || 0, onboardingCostOnce: a.onboardingCostOnce || 0,
        supportLog: a.supportLog || [],
        disposition: a.disposition || '', dispositionAt: a.dispositionAt || null, dispositionNote: a.dispositionNote || '',
      },
      checklist: checklistFor(a),
      gates: gates(a),
      card: byId[String(a._id)] || null,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// PATCH /api/admin/agents/:id/profile — the person, not the account.
// Deliberately refuses a full TIN: only the last four are ever stored, because
// this stack has no private file/field storage and an SSN must not exist in it.
async function updateProfile(req, res) {
  try {
    const a = await AdminUser.findOne({ _id: req.params.id, role: 'agent' });
    if (!a) return res.status(404).json({ message: 'Agent not found.' });
    const b = req.body || {};
    const str = (k, max = 200) => { if (k in b) a[k] = String(b[k] || '').trim().slice(0, max); };
    ['legalName', 'contactEmail', 'phone', 'entityName', 'entityEin', 'recruitSource', 'territory'].forEach((k) => str(k));
    if ('hasOtherClients' in b) a.hasOtherClients = !!b.hasOtherClients;
    if ('tinLast4' in b) {
      const raw = String(b.tinLast4 || '').replace(/\D/g, '');
      if (raw.length > 4) {
        return res.status(400).json({
          message: 'Only the last four digits of a TIN are stored here. Keep the W-9 itself somewhere built to hold it.',
        });
      }
      a.tinLast4 = raw;
    }
    if ('seatCostMonthly' in b) a.seatCostMonthly = Math.max(0, Number(b.seatCostMonthly) || 0);
    if ('onboardingCostOnce' in b) a.onboardingCostOnce = Math.max(0, Number(b.onboardingCostOnce) || 0);
    if ('disposition' in b && ['', 'keep', 'coach', 'cut'].includes(b.disposition)) {
      a.disposition = b.disposition;
      a.dispositionAt = b.disposition ? new Date() : null;
    }
    if ('dispositionNote' in b) a.dispositionNote = String(b.dispositionNote || '').slice(0, 2000);
    a.status = impliedStatus(a) || a.status;
    await a.save();
    res.json({ ok: true, status: a.status });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// POST /api/admin/agents/:id/onboarding { key, done, note } — tick or untick.
async function setOnboardingStep(req, res) {
  try {
    const a = await AdminUser.findOne({ _id: req.params.id, role: 'agent' });
    if (!a) return res.status(404).json({ message: 'Agent not found.' });
    const key = String((req.body || {}).key || '');
    if (!STEP_KEYS.includes(key)) return res.status(400).json({ message: 'Unknown onboarding step.' });
    const done = (req.body || {}).done !== false;

    if (!a.onboarding) a.onboarding = new Map();
    if (done) {
      a.onboarding.set(key, {
        doneAt: new Date(),
        by: (req.user && req.user.username) || 'studio',
        note: String((req.body || {}).note || '').slice(0, 500),
      });
    } else {
      a.onboarding.delete(key);
    }

    // Ticking "cleared to sell" is what starts the ramp clock — recorded here so
    // time-to-first-sale never counts a slow paperwork week against the rep.
    const cl = checklistFor(a);
    if (cl.complete && !a.startedSellingAt) a.startedSellingAt = new Date();
    a.status = impliedStatus(a) || a.status;
    await a.save();
    res.json({ ok: true, checklist: checklistFor(a), gates: gates(a), status: a.status });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// POST /api/admin/agents/:id/support { minutes, note } — log a check-in.
// The scarce input in a solo-owner network is the owner's own hours; unless they
// are recorded, cost-per-rep is fiction and "how many can I carry" is a guess.
async function logSupport(req, res) {
  try {
    const a = await AdminUser.findOne({ _id: req.params.id, role: 'agent' });
    if (!a) return res.status(404).json({ message: 'Agent not found.' });
    const minutes = Math.max(0, Math.round(Number((req.body || {}).minutes) || 0));
    if (!minutes) return res.status(400).json({ message: 'How many minutes?' });
    if (!a.supportLog) a.supportLog = [];
    a.supportLog.push({ at: new Date(), minutes, note: String((req.body || {}).note || '').slice(0, 500) });
    await a.save();
    res.json({ ok: true, supportLog: a.supportLog });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// POST /api/admin/agents/:id/depart { kind, reason } — the one write that makes
// retention computable. Records WHEN and WHY, revokes access, and leaves the
// book where it is so the owner can reassign it deliberately (see
// admin.reassignAgentBook) rather than having it moved out from under them.
async function departAgent(req, res) {
  try {
    const a = await AdminUser.findOne({ _id: req.params.id, role: 'agent' });
    if (!a) return res.status(404).json({ message: 'Agent not found.' });
    const kind = String((req.body || {}).kind || 'other');
    if (!['quit', 'let_go', 'never_started', 'other'].includes(kind)) {
      return res.status(400).json({ message: 'Pick how it ended.' });
    }
    a.departedAt = a.departedAt || new Date();
    a.departedKind = kind;
    a.departedReason = String((req.body || {}).reason || '').slice(0, 1000);
    a.active = false;
    a.credentialsChangedAt = new Date();   // kills the live session on their next request
    a.status = 'departed';
    await a.save();
    res.json({
      ok: true, status: a.status, departedAt: a.departedAt,
      // The owner's next move, stated rather than assumed.
      nextStep: 'Their book is untouched. Use Move book to hand it on, and pay any final commission — New Jersey puts treble damages behind a late final payment.',
    });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// POST /api/admin/agents/:id/reinstate — undo a departure (a rehire, or a misclick).
async function reinstateAgent(req, res) {
  try {
    const a = await AdminUser.findOne({ _id: req.params.id, role: 'agent' });
    if (!a) return res.status(404).json({ message: 'Agent not found.' });
    a.departedAt = null; a.departedKind = ''; a.departedReason = '';
    a.active = true;
    a.status = impliedStatus(a) || 'onboarding';
    await a.save();
    res.json({ ok: true, status: a.status });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

module.exports = {
  OWNER_ONLY,
  loadRoster, roster, scorecardOne, updateProfile,
  setOnboardingStep, logSupport, departAgent, reinstateAgent,
};
