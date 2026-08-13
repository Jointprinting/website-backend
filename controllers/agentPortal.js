// controllers/agentPortal.js
//
// The SALES-AGENT portal API, mounted at /api/agent behind requireAuth. This is
// the ONLY server surface an agent's token can reach for their book of business:
// their own leads (CRM) and their own orders (sales), plus their goal + live
// stats. Every read is scoped by visibleFilter and every write is stamped /
// guarded by the P2 scope helpers, so an agent can never see or touch the
// owner's — or another agent's — records.
//
// Deliberately narrow: this router exposes NONE of the cost / PO / vendor /
// confirmation / cleanup surface the owner's routers carry (those stay behind
// requireOwner / requireAdmin). It reuses the same Order / Client models and the
// SAME computeAgentStats rollup as the owner's Admin tab, so the agent and the
// owner always read identical numbers.

const Order = require('../models/Order');
const Client = require('../models/Client');
const Transaction = require('../models/Transaction');
const { deriveCompanyKey } = require('../models/Order');
const AdminUser = require('../models/AdminUser');
const { nextNumber } = require('../utils/sequence');
const { visibleFilter, stampFor, ownershipStamp, canAccessDoc } = require('../middleware/scope');
const { computeAgentStats, currentMonth } = require('./admin');
const { orderRevenueCost, normalizeOrderNumber, signed } = require('./finances');
const {
  normalizeConfig, tierFor, nextTierFor, originKind, earnedState, commissionForOrder,
} = require('../services/commission');

const CRM_STAGES = Client.CRM_STAGES;

// Order statuses an agent may set. The heavy production lifecycle (POs, tracking,
// confirmations) stays owner-run — an agent logs the SALE and its coarse state.
const AGENT_ORDER_STATUSES = ['quoted', 'approved', 'placed', 'in_production', 'shipped', 'delivered', 'cancelled'];

// Lean, cost-FREE order shape for the agent — NEVER cogs / margins / receipts.
function agentOrderShape(o) {
  return {
    id: String(o._id),
    orderNumber: o.orderNumber || '',
    projectNumber: o.projectNumber || '',
    companyName: o.companyName || '',
    clientName: o.clientName || '',
    companyKey: o.companyKey || '',
    status: o.status || 'quoted',
    totalValue: Number(o.totalValue) || 0,
    orderDate: o.orderDate || null,
    shipDate: o.shipDate || null,
    deliveredDate: o.deliveredDate || null,
    notes: o.notes || '',
    createdAt: o.createdAt || null,
    updatedAt: o.updatedAt || null,
  };
}

// Lean lead/company card for the agent's CRM.
function agentLeadShape(c) {
  return {
    companyKey: c.companyKey,
    companyName: c.companyName || '',
    clientName: c.clientName || '',
    phone: c.phone || '',
    email: c.email || '',
    stage: c.stage || 'lead',
    interestType: c.interestType || '',
    dealValue: Number(c.dealValue) || 0,
    area: c.area || '',
    address: c.address || '',
    nextFollowUp: c.nextFollowUp || null,
    lastContact: c.lastContact || null,
    notes: c.notes || '',
    contacts: Array.isArray(c.contacts) ? c.contacts : [],
    log: Array.isArray(c.log) ? c.log.slice(-30) : [],
    updatedAt: c.updatedAt || null,
  };
}

// GET /api/agent/me — the signed-in agent's identity + live stats (the SAME rollup
// the owner sees in the Admin tab). An owner hitting this gets identity + null stats.
async function me(req, res) {
  try {
    const uid = (req.user && req.user.userId) || '';
    const user = uid ? await AdminUser.findById(uid) : null;
    if (!user) {
      return res.json({
        username: (req.user && req.user.username) || '',
        displayName: '', role: (req.user && req.user.role) || 'owner', stats: null,
      });
    }
    const stats = user.role === 'agent' ? await computeAgentStats(user) : null;
    res.json({
      username: user.username,
      displayName: user.displayName || '',
      role: user.role || 'agent',
      goal: user.monthlyGoal || 0,
      goalMonth: user.goalMonth || currentMonth(),
      stats,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// GET /api/agent/orders — the agent's own orders.
async function listMyOrders(req, res) {
  try {
    const filter = { ...visibleFilter(req), archived: { $ne: true } };
    const orders = await Order.find(filter)
      .select('orderNumber projectNumber companyName clientName companyKey status totalValue orderDate shipDate deliveredDate notes createdAt updatedAt agentId')
      .sort({ updatedAt: -1 }).lean();
    res.json({ orders: orders.map(agentOrderShape) });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// POST /api/agent/orders — log a sale. Lean: company + value + coarse status; the
// owner takes it through production. Stamped to this agent; gets a project #.
async function createMyOrder(req, res) {
  try {
    const b = req.body || {};
    const companyName = String(b.companyName || '').trim();
    const clientName = String(b.clientName || '').trim();
    if (!companyName && !clientName) return res.status(400).json({ message: 'A company or client name is required.' });
    const status = AGENT_ORDER_STATUSES.includes(b.status) ? b.status : 'quoted';
    const companyKey = deriveCompanyKey(companyName, clientName);
    const order = await Order.create({
      projectNumber: await nextNumber('project'),
      companyName, clientName,
      companyKey,
      status,
      totalValue: Math.max(0, Number(b.totalValue) || 0),
      notes: String(b.notes || '').trim(),
      orderDate: b.orderDate ? new Date(b.orderDate) : new Date(),
      ...ownershipStamp(req),
    });

    // Keep the agent's CRM coherent: if NO company card exists for this key yet,
    // create one stamped to them (stage 'customer' — they just made a sale), so
    // the company they sold to shows up in "My Leads". If a card already exists
    // (theirs or the owner's), we leave it — the order still links to it by key
    // for the owner's cross-tool views.
    try {
      if (companyKey && !(await Client.findOne({ companyKey }).select('_id').lean())) {
        await Client.create({
          companyKey, companyName, clientName,
          stage: 'customer', source: 'agent', leadSource: 'Referral',
          ...ownershipStamp(req),
        });
      }
    } catch (_) { /* best-effort — a lead race just means the card already exists */ }

    res.status(201).json({ order: agentOrderShape(order.toObject()) });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// PUT /api/agent/orders/:id — update coarse fields on the agent's OWN order.
async function updateMyOrder(req, res) {
  try {
    const order = await Order.findById(req.params.id);
    if (!order || order.archived) return res.status(404).json({ message: 'Order not found.' });
    if (!canAccessDoc(req, order)) return res.status(403).json({ message: 'Not your order.' });
    const b = req.body || {};
    if ('status' in b && AGENT_ORDER_STATUSES.includes(b.status)) order.status = b.status;
    if ('totalValue' in b) order.totalValue = Math.max(0, Number(b.totalValue) || 0);
    if ('notes' in b) order.notes = String(b.notes || '').trim();
    if ('companyName' in b) order.companyName = String(b.companyName || '').trim();
    if ('clientName' in b) order.clientName = String(b.clientName || '').trim();
    if ('orderDate' in b) order.orderDate = b.orderDate ? new Date(b.orderDate) : order.orderDate;
    await order.save();
    res.json({ order: agentOrderShape(order.toObject()) });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// GET /api/agent/leads — the agent's own CRM companies.
async function listMyLeads(req, res) {
  try {
    const filter = { ...visibleFilter(req), archived: { $ne: true } };
    const clients = await Client.find(filter)
      .select('companyKey companyName clientName phone email stage interestType dealValue area address nextFollowUp lastContact notes contacts log updatedAt agentId')
      .sort({ updatedAt: -1 }).lean();
    res.json({ leads: clients.map(agentLeadShape) });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// POST /api/agent/leads — add a lead/company. Returns an existing card the agent
// already owns with the same key; refuses to hijack the owner's / another agent's
// card of the same key (409).
async function createMyLead(req, res) {
  try {
    const b = req.body || {};
    const companyName = String(b.companyName || '').trim();
    const clientName = String(b.clientName || '').trim();
    if (!companyName && !clientName) return res.status(400).json({ message: 'A company or contact name is required.' });
    const companyKey = deriveCompanyKey(companyName, clientName);
    if (!companyKey) return res.status(400).json({ message: 'Could not derive a key from that name.' });

    const existing = await Client.findOne({ companyKey });
    if (existing) {
      if (!canAccessDoc(req, existing)) return res.status(409).json({ message: 'A company with that name already exists.' });
      return res.status(200).json({ lead: agentLeadShape(existing.toObject()), existed: true });
    }

    const phone = String(b.phone || '').trim();
    const email = String(b.email || '').trim();
    const contacts = (phone || email || clientName)
      ? [{ name: clientName || companyName, phone, email, isPrimary: true }] : [];
    const lead = await Client.create({
      companyKey, companyName, clientName, phone, email,
      stage: CRM_STAGES.includes(b.stage) ? b.stage : 'lead',
      interestType: b.interestType || '',
      dealValue: Math.max(0, Number(b.dealValue) || 0),
      notes: String(b.notes || '').trim(),
      area: String(b.area || '').trim(),
      source: 'agent',
      leadSource: 'Referral', // agent-brought — closest structured source
      contacts,
      ...ownershipStamp(req),
    });
    res.status(201).json({ lead: agentLeadShape(lead.toObject()) });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// PATCH /api/agent/leads/:companyKey — update the agent's own card + optionally log
// a touch (call / text / note). Coarse, sales-focused fields only.
async function updateMyLead(req, res) {
  try {
    const lead = await Client.findOne({ companyKey: req.params.companyKey });
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    if (!canAccessDoc(req, lead)) return res.status(403).json({ message: 'Not your lead.' });
    const b = req.body || {};
    if ('stage' in b && CRM_STAGES.includes(b.stage)) lead.stage = b.stage;
    if ('dealValue' in b) lead.dealValue = Math.max(0, Number(b.dealValue) || 0);
    if ('interestType' in b) lead.interestType = b.interestType || '';
    if ('notes' in b) lead.notes = String(b.notes || '');
    if ('phone' in b) lead.phone = String(b.phone || '').trim();
    if ('email' in b) lead.email = String(b.email || '').trim();
    if ('nextFollowUp' in b) lead.nextFollowUp = b.nextFollowUp ? new Date(b.nextFollowUp) : null;
    // Append a touch to the log and advance lastContact for real contact kinds.
    const entry = b.logEntry || b.log;
    if (entry && (entry.text || entry.kind)) {
      // Stamp WHO logged it. The card's agentId is mutable (reassignment moves
      // it), so without an author the whole activity history of a departed agent
      // would silently re-attribute to whoever inherits the book.
      lead.log.push({
        at: new Date(),
        text: String(entry.text || ''),
        kind: String(entry.kind || 'note'),
        by: stampFor(req),
      });
      if (['call', 'text', 'email', 'visit'].includes(entry.kind)) lead.lastContact = new Date();
    }
    await lead.save();
    res.json({ lead: agentLeadShape(lead.toObject()) });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// ── My Earnings ──────────────────────────────────────────────────────────────
//
// The agent is paid on a number the portal deliberately hides from them — every
// other read here strips cost. That is a trust problem on day one, so this
// endpoint opens exactly one window: for THEIR OWN orders, the single figure
// "what this job cost" alongside the profit and their cut. Never the vendor
// breakdown — they can verify their own pay without learning what the owner
// pays Heritage, which is the confidential asset the rep agreement protects.
//
// Profit is computed with `orderRevenueCost` — the SAME canonical rule the
// owner's Finances tab uses — so the agent's statement and the owner's P&L
// reconcile to the cent. Where the owner hasn't booked receipts yet the row
// falls back to the order's stored quote/confirmation estimate and says so,
// rather than reporting a job as pure profit.

// One earnings row's money, actual-first with an honest estimate fallback.
//
// COMMISSION IS EXCLUDED FROM COST ON PURPOSE. `orderRevenueCost` is the
// canonical P&L rule and counts every COGS category — including `Commission`,
// which is where the owner books what he pays THIS agent. Feeding that straight
// back into a commission calculation is circular: the moment a payout is
// booked, the order's profit drops by the payout, so the next read pays a
// smaller percentage of a smaller number, and the statement the agent already
// agreed to silently changes underneath them.
//
// So we take the canonical cost and add the booked commission back. That is
// exactly the "profit BEFORE this agent's own commission" basis
// services/commission.js documents, and the basis the historical rows were
// computed on — order #000001 booked $84.67, which is 10.00% of $846.65, the
// profit with that $84.67 added back.
function orderMoney(order, ledgerRows) {
  const rows = ledgerRows || [];
  const actual = orderRevenueCost(rows);
  const commissionBooked = rows.reduce(
    (s, t) => (t && t.type === 'expense' && t.category === 'Commission' ? s + signed(t) : s), 0,
  );
  actual.cost = Math.round((actual.cost - commissionBooked) * 100) / 100;
  const estRevenue = Math.max(0, Number(order.totalValue) || 0);
  const estCost = Math.max(0, Number(order.cogs) || 0);
  // Revenue: the ledger is truth when a sale is booked; otherwise the order's
  // own total (the owner invoices in QuickBooks and doesn't always enter a
  // Client Sales row, so requiring the ledger would read $0 on real jobs).
  const revenue = actual.revenue !== 0 ? actual.revenue : estRevenue;
  // Cost: same idea. `costIsEstimate` is what the UI badges — an earned order
  // whose receipts aren't in yet still shows a number, just a provisional one.
  const costIsEstimate = actual.cost <= 0 && estCost > 0;
  const cost = actual.cost > 0 ? actual.cost : estCost;
  return {
    revenue: Math.round(revenue * 100) / 100,
    cost: Math.round(cost * 100) / 100,
    profit: Math.round((revenue - cost) * 100) / 100,
    costIsEstimate,
    // True when we have neither a booked cost nor a quote estimate — the job
    // would otherwise read as 100% profit, which is never real for a broker.
    costUnknown: actual.cost <= 0 && estCost <= 0,
  };
}

// GET /api/agent/earnings — the agent's own statement.
async function myEarnings(req, res) {
  try {
    const uid = String((req.user && req.user.userId) || '');
    const user = uid ? await AdminUser.findById(uid) : null;
    if (!user || user.role !== 'agent') {
      return res.json({ enabled: false, orders: [], rollup: null });
    }
    const config = normalizeConfig(user.commission);
    if (!config.enabled) {
      // Terms not agreed yet — say so plainly instead of showing $0 everywhere,
      // which would read as "you've earned nothing".
      return res.json({ enabled: false, orders: [], rollup: null });
    }

    // Their book for pay purposes: anything they SOURCED (commission follows
    // origination, so a reassigned book still pays the person who sold it) plus
    // anything currently on their desk (a house lead the owner handed them).
    const orders = await Order.find({
      $or: [{ agentId: uid }, { originAgentId: uid }],
      archived: { $ne: true },
    })
      .select('orderNumber projectNumber companyName clientName companyKey status totalValue cogs orderDate deliveredDate paid createdAt agentId originAgentId')
      .sort({ orderDate: 1, createdAt: 1 })   // chronological: reorder detection needs order
      .lean();

    // One ledger read, narrowed to THIS agent's orders and bucketed by canonical
    // order number. The stored orderNumber may be zero-padded ("0000021") or not
    // ("21"), so match on every spelling of each number rather than scanning the
    // whole ledger. `isCredit` must be selected — it is what makes a supplier
    // credit subtract instead of add.
    const numbers = [...new Set(orders.map((o) => normalizeOrderNumber(o.orderNumber)).filter(Boolean))];
    const rowsByOrder = {};
    if (numbers.length) {
      const spellings = numbers.flatMap((n) => [n, n.padStart(6, '0'), n.padStart(7, '0')]);
      const txns = await Transaction.find({ orderNumber: { $in: [...new Set(spellings)] } })
        .select('orderNumber type category amount isCredit').lean();
      for (const t of txns) {
        const k = normalizeOrderNumber(t.orderNumber);
        if (k) (rowsByOrder[k] ||= []).push(t);
      }
    }

    // Walk chronologically, accumulating the ladder as we go, so an order is
    // rated at the tier the agent had WHEN it landed — not retroactively at
    // today's tier. That is what makes the ladder feel earned rather than
    // recalculated, and it stops a statement changing after it was paid.
    let lifetimeProfit = 0;      // sourced profit banked so far (earned orders only)
    let selfOrdersCompleted = 0; // spent fast-start credits
    const seenByCompany = {};    // companyKey → this agent's earlier order count
    const rows = [];

    for (const o of orders) {
      const money = orderMoney(o, rowsByOrder[normalizeOrderNumber(o.orderNumber)]);
      const sourcedByAgent = String(o.originAgentId || '') === uid;
      const ck = o.companyKey || '';
      const kind = originKind({ sourcedByAgent, priorOrdersForCompany: ck ? (seenByCompany[ck] || 0) : 0 });
      const state = earnedState(o);
      const calc = commissionForOrder({
        profit: money.profit, kind, lifetimeProfit, selfOrdersCompleted, config, state,
      });

      rows.push({
        id: String(o._id),
        orderNumber: o.orderNumber || '',
        projectNumber: o.projectNumber || '',
        companyName: o.companyName || o.clientName || '',
        companyKey: ck,
        status: o.status || 'quoted',
        orderDate: o.orderDate || o.createdAt || null,
        revenue: money.revenue,
        cost: money.cost,                    // ONE figure — never the vendor lines
        profit: money.profit,
        costIsEstimate: money.costIsEstimate,
        costUnknown: money.costUnknown,
        ...calc,
      });

      if (ck) seenByCompany[ck] = (seenByCompany[ck] || 0) + 1;
      // Only EARNED orders move the ladder and spend fast-start credits — a
      // pending forecast must not promote someone to a higher rate.
      if (state === 'earned') {
        if (sourcedByAgent) { lifetimeProfit += Math.max(0, money.profit); selfOrdersCompleted += 1; }
      }
    }

    const month = currentMonth();
    const inMonth = (d) => {
      if (!d) return false;
      const t = new Date(d);
      return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}` === month;
    };
    const earned = rows.filter((r) => r.state === 'earned');
    const pending = rows.filter((r) => r.state === 'pending');
    const sum = (arr, k) => Math.round(arr.reduce((s, r) => s + (Number(r[k]) || 0), 0) * 100) / 100;

    res.json({
      enabled: true,
      month,
      rollup: {
        earnedAllTime: sum(earned, 'commission'),
        earnedThisMonth: sum(earned.filter((r) => inMonth(r.orderDate)), 'commission'),
        pendingForecast: sum(pending, 'commission'),
        ordersEarned: earned.length,
        ordersPending: pending.length,
        lifetimeProfit: Math.round(lifetimeProfit * 100) / 100,
        tier: tierFor(lifetimeProfit, config),
        nextTier: nextTierFor(lifetimeProfit, config),
        fastStartRemaining: Math.max(0, config.fastStartOrders - selfOrdersCompleted),
        // Any row still on an estimate is worth surfacing once, not per row —
        // it explains why a total might shift when the owner books receipts.
        estimatedRows: rows.filter((r) => r.costIsEstimate || r.costUnknown).length,
      },
      orders: rows.reverse(),   // newest first for display
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

module.exports = {
  me, listMyOrders, createMyOrder, updateMyOrder,
  listMyLeads, createMyLead, updateMyLead, myEarnings,
  agentOrderShape, agentLeadShape, orderMoney, AGENT_ORDER_STATUSES, // exported for tests
};
