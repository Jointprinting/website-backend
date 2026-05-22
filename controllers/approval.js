const crypto = require('crypto');
const Order = require('../models/Order');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const ClientLogo = require('../models/ClientLogo');

// ── Admin: generate / fetch the project's approval link token ─────────────────
const ensureApprovalToken = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Project not found' });
    if (!order.approvalToken) {
      order.approvalToken = crypto.randomBytes(16).toString('hex');
      await order.save();
    }
    res.json({ token: order.approvalToken, projectId: order._id });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// ── Public approval surface (no auth — token-gated) ───────────────────────────
async function _loadProjectByToken(projectId, token) {
  if (!projectId || !token) return null;
  const order = await Order.findById(projectId).lean();
  if (!order) return null;
  if (!order.approvalToken || order.approvalToken !== token) return null;
  return order;
}

// GET /api/public/projects/:id?token=... — read-only project view (mockups, items, totals)
const publicGetProject = async (req, res) => {
  try {
    const order = await _loadProjectByToken(req.params.id, req.query.token);
    if (!order) return res.status(404).json({ message: 'Not found or invalid link.' });

    const norm = (n) => String(n || '').replace(/^#/, '').replace(/^0+/, '').toUpperCase();
    const mockupRefs = order.mockupNumbers || [];
    const mockupItems = await StudioLibraryItem
      .find({ store: 'mockups' })
      .select('name pageState.mockupNum thumbnail')
      .lean();
    const byNorm = {};
    mockupItems.forEach(m => {
      const k = norm(m.pageState && m.pageState.mockupNum);
      if (k) byNorm[k] = m;
    });
    const mockups = mockupRefs
      .map(n => byNorm[norm(n)])
      .filter(Boolean)
      .map(m => ({ name: m.name, thumbnail: m.thumbnail, mockupNum: m.pageState?.mockupNum }));

    const logo = await ClientLogo.findOne({ companyKey: order.companyKey }).select('imageDataUrl').lean();

    // Log the view (best-effort, throttled — only log if last event isn't a recent view)
    const last = (order.approvalEvents || []).slice(-1)[0];
    const recentView = last && last.kind === 'viewed' && (Date.now() - new Date(last.at).getTime() < 5 * 60 * 1000);
    if (!recentView) {
      await Order.updateOne({ _id: order._id },
        { $push: { approvalEvents: { kind: 'viewed', at: new Date() } } });
    }

    res.json({
      project: {
        projectNumber:        order.projectNumber,
        orderNumber:          order.orderNumber,
        companyName:          order.companyName,
        clientName:           order.clientName,
        status:               order.status,
        totalValue:           order.totalValue,
        items:                order.items,
        quoteLines:           order.quoteLines,
        mockupNumbers:        order.mockupNumbers,
        confirmationMessage:  order.confirmationMessage,
        confirmationTerms:    order.confirmationTerms,
        orderDate:            order.orderDate,
      },
      mockups,
      logo: logo ? logo.imageDataUrl : null,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/public/projects/:id/approve?token=... — client approval action
const publicApprove = async (req, res) => {
  try {
    const order = await _loadProjectByToken(req.params.id, req.query.token);
    if (!order) return res.status(404).json({ message: 'Not found or invalid link.' });
    const update = {
      $push: { approvalEvents: { kind: 'approved', message: '', at: new Date() } },
    };
    // Only auto-bump status if currently quoted (don't override a manual placed/in_production)
    if (order.status === 'quoted') update.$set = { status: 'approved' };
    await Order.updateOne({ _id: order._id }, update);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/public/projects/:id/feedback?token=... — body: { message }
const publicRequestChanges = async (req, res) => {
  try {
    const order = await _loadProjectByToken(req.params.id, req.query.token);
    if (!order) return res.status(404).json({ message: 'Not found or invalid link.' });
    const message = String((req.body && req.body.message) || '').slice(0, 2000);
    await Order.updateOne(
      { _id: order._id },
      { $push: { approvalEvents: { kind: 'requested_changes', message, at: new Date() } } },
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

module.exports = {
  ensureApprovalToken,
  publicGetProject, publicApprove, publicRequestChanges,
};
