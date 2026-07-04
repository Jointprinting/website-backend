// controllers/admin.js
//
// OWNER-only agent management + rollups — the backend for the Studio's Admin tab.
// The owner onboards sales agents (username + password), sets their monthly sales
// goal, activates/deactivates them, and sees how they're doing + how often they
// log in. All routes sit behind requireOwner (routes/adminRoutes.js), so an agent
// can never reach any of this. Agents are AdminUser rows with role 'agent'.

const bcrypt = require('bcrypt');
const AdminUser = require('../models/AdminUser');
const Order = require('../models/Order');
const Client = require('../models/Client');
const { PLACED_STATUSES } = require('../models/Order');

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,29}$/; // 2–30 chars, starts alnum
const MIN_PASSWORD = 8;

// 'YYYY-MM' for the current UTC month — the goal period key.
function currentMonth(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Shape an AdminUser for the client — NEVER the password hash.
function publicAgent(a) {
  return {
    id: String(a._id),
    username: a.username,
    displayName: a.displayName || '',
    active: a.active !== false,
    monthlyGoal: a.monthlyGoal || 0,
    goalMonth: a.goalMonth || '',
    loginCount: a.loginCount || 0,
    lastLoginAt: a.lastLoginAt || null,
    createdAt: a.createdAt || null,
    createdBy: a.createdBy || '',
  };
}

// An agent's live rollup: their leads, orders, this-month sales vs goal, and a
// simple on-pace read. Pure-ish (one agentId → aggregate queries). Reused by the
// agent's own dashboard (P4) so the owner and the agent see the SAME numbers.
async function computeAgentStats(agent) {
  const agentId = String(agent._id);
  // Always measure against the CURRENT calendar month. monthlyGoal is a recurring
  // monthly target, so a stored goalMonth from when it was set must NOT freeze the
  // window — otherwise an agent onboarded in May would still see May's numbers in
  // July, stuck on a permanent "behind pace". goalMonth stays as set-on metadata.
  const month = currentMonth();
  const [y, m] = month.split('-').map(Number);
  const start = new Date(Date.UTC(y, (m || 1) - 1, 1));
  const end = new Date(Date.UTC(y, (m || 1), 1));

  const [leadCount, orders] = await Promise.all([
    Client.countDocuments({ agentId, archived: { $ne: true } }).catch(() => 0),
    Order.find({ agentId, archived: { $ne: true } })
      .select('status totalValue orderDate createdAt').lean().catch(() => []),
  ]);

  const inMonth = (o) => {
    const t = new Date(o.orderDate || o.createdAt || 0);
    return t >= start && t < end;
  };
  const isSale = (o) => PLACED_STATUSES.includes(o.status);
  const openOrders = orders.filter((o) => !['delivered', 'cancelled'].includes(o.status)).length;
  const salesThisMonth = orders
    .filter((o) => isSale(o) && inMonth(o))
    .reduce((s, o) => s + (Number(o.totalValue) || 0), 0);
  const ordersThisMonth = orders.filter((o) => isSale(o) && inMonth(o)).length;

  const goal = Number(agent.monthlyGoal) || 0;
  const progress = goal > 0 ? salesThisMonth / goal : 0;

  // On-pace: fraction of the month elapsed vs fraction of goal hit.
  const now = new Date();
  const monthFrac = Math.min(1, Math.max(0, (Math.min(now, end) - start) / (end - start)));
  const onPace = goal > 0 ? progress >= monthFrac * 0.9 : null; // within 10% of linear pace

  // ONE canonical pace label both the owner card and the agent hero render, so
  // "On pace / Ahead / Behind" never disagrees between the two views of the same
  // numbers. 'none' = no goal set.
  const expected = goal * monthFrac;
  const paceLabel = goal <= 0 ? 'none'
    : progress >= 1 ? 'hit'
    : salesThisMonth >= expected * 1.1 ? 'ahead'
    : onPace ? 'on'
    : 'behind';

  return {
    month, goal,
    salesThisMonth: Math.round(salesThisMonth),
    ordersThisMonth,
    progress: Math.round(progress * 100) / 100,
    onPace, paceLabel, monthFrac: Math.round(monthFrac * 100) / 100,
    leads: leadCount,
    openOrders,
    totalOrders: orders.length,
  };
}

// GET /api/admin/agents — the roster with each agent's live rollup.
async function listAgents(_req, res) {
  try {
    const agents = await AdminUser.find({ role: 'agent' }).sort({ createdAt: -1 });
    const withStats = await Promise.all(agents.map(async (a) => ({
      ...publicAgent(a),
      stats: await computeAgentStats(a),
    })));
    res.json({ agents: withStats });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// POST /api/admin/agents { username, displayName, password, monthlyGoal }
async function createAgent(req, res) {
  try {
    const body = req.body || {};
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!USERNAME_RE.test(username)) {
      return res.status(400).json({ message: 'Username must be 2–30 characters: letters, numbers, and . _ - (starting with a letter or number).' });
    }
    if (username === 'studio') return res.status(400).json({ message: 'That username is reserved.' });
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD} characters.` });
    }
    if (await AdminUser.findOne({ username })) {
      return res.status(409).json({ message: 'That username is already taken.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const agent = await AdminUser.create({
      username,
      passwordHash,
      role: 'agent',
      displayName: String(body.displayName || '').trim(),
      monthlyGoal: Math.max(0, Number(body.monthlyGoal) || 0),
      goalMonth: currentMonth(),
      active: true,
      createdBy: (req.user && req.user.username) || 'studio',
    });
    res.status(201).json({ agent: { ...publicAgent(agent), stats: await computeAgentStats(agent) } });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// PATCH /api/admin/agents/:id — editable fields only (never the password here).
async function updateAgent(req, res) {
  try {
    const body = req.body || {};
    const agent = await AdminUser.findOne({ _id: req.params.id, role: 'agent' });
    if (!agent) return res.status(404).json({ message: 'Agent not found.' });
    if ('displayName' in body) agent.displayName = String(body.displayName || '').trim();
    if ('active' in body) {
      const nowActive = !!body.active;
      // Disabling revokes their live session on the next request (requireActiveAgent).
      if (agent.active !== false && nowActive === false) agent.credentialsChangedAt = new Date();
      agent.active = nowActive;
    }
    if ('monthlyGoal' in body) agent.monthlyGoal = Math.max(0, Number(body.monthlyGoal) || 0);
    if ('goalMonth' in body && /^\d{4}-\d{2}$/.test(String(body.goalMonth))) agent.goalMonth = String(body.goalMonth);
    // Setting a goal with no month yet → default it to the current month.
    if ('monthlyGoal' in body && !agent.goalMonth) agent.goalMonth = currentMonth();
    await agent.save();
    res.json({ agent: { ...publicAgent(agent), stats: await computeAgentStats(agent) } });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/admin/agents/:id/password { password } — owner resets an agent's key.
async function resetAgentPassword(req, res) {
  try {
    const password = String((req.body || {}).password || '');
    if (password.length < MIN_PASSWORD) {
      return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD} characters.` });
    }
    const agent = await AdminUser.findOne({ _id: req.params.id, role: 'agent' });
    if (!agent) return res.status(404).json({ message: 'Agent not found.' });
    agent.passwordHash = await bcrypt.hash(password, 12);
    // A reset also clears any active lockout so the agent can get straight back in.
    agent.failedLoginAttempts = 0;
    agent.lockedUntil = null;
    // Revoke any session issued under the old password (requireActiveAgent), so a
    // reset truly locks out whoever had the previous one.
    agent.credentialsChangedAt = new Date();
    await agent.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// GET /api/admin/agents/:id/orders — the owner drilling into ONE agent's sales.
// Read-only; the owner's own Order Tracker stays their projects (this is a
// separate "manage their book" view, keyed strictly to the agent's id).
async function listAgentOrders(req, res) {
  try {
    const agent = await AdminUser.findOne({ _id: req.params.id, role: 'agent' });
    if (!agent) return res.status(404).json({ message: 'Agent not found.' });
    const orders = await Order.find({ agentId: String(agent._id), archived: { $ne: true } })
      .select('orderNumber projectNumber companyName clientName companyKey status totalValue orderDate createdAt updatedAt')
      .sort({ updatedAt: -1 }).lean();
    res.json({ orders: orders.map((o) => ({ ...o, id: String(o._id) })) });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// GET /api/admin/agents/:id/leads — the owner drilling into ONE agent's CRM.
async function listAgentLeads(req, res) {
  try {
    const agent = await AdminUser.findOne({ _id: req.params.id, role: 'agent' });
    if (!agent) return res.status(404).json({ message: 'Agent not found.' });
    const leads = await Client.find({ agentId: String(agent._id), archived: { $ne: true } })
      .select('companyKey companyName clientName phone email stage dealValue nextFollowUp lastContact updatedAt')
      .sort({ updatedAt: -1 }).lean();
    res.json({ leads });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

module.exports = {
  listAgents, createAgent, updateAgent, resetAgentPassword,
  listAgentOrders, listAgentLeads,
  computeAgentStats, publicAgent, currentMonth, // exported for P4 + tests
};
