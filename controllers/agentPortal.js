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
const { deriveCompanyKey } = require('../models/Order');
const AdminUser = require('../models/AdminUser');
const { nextNumber } = require('../utils/sequence');
const { visibleFilter, stampFor, canAccessDoc } = require('../middleware/scope');
const { computeAgentStats, currentMonth } = require('./admin');

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
      agentId: stampFor(req),
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
          agentId: stampFor(req),
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
      agentId: stampFor(req),
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
      lead.log.push({ at: new Date(), text: String(entry.text || ''), kind: String(entry.kind || 'note') });
      if (['call', 'text', 'email', 'visit'].includes(entry.kind)) lead.lastContact = new Date();
    }
    await lead.save();
    res.json({ lead: agentLeadShape(lead.toObject()) });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

module.exports = {
  me, listMyOrders, createMyOrder, updateMyOrder,
  listMyLeads, createMyLead, updateMyLead,
  agentOrderShape, agentLeadShape, AGENT_ORDER_STATUSES, // exported for tests
};
