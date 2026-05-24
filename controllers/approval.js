const crypto = require('crypto');
const Order = require('../models/Order');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const ClientLogo = require('../models/ClientLogo');
const sendEmail = require('../utils/sendEmail');

const DEFAULT_TTL_DAYS = 7;
const MAX_TTL_DAYS     = 365;

// Notification target. Override with APPROVAL_NOTIFY_EMAIL.
const NOTIFY_EMAIL = process.env.APPROVAL_NOTIFY_EMAIL || process.env.EMAIL_FROM || 'nate@jointprinting.com';

// ── Admin: generate / fetch the project's approval link token ─────────────────
// Accepts ttlDays in the body (default 7, capped at 365). A request with a
// non-default ttlDays rotates the token so the previous link expires too.
const ensureApprovalToken = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Project not found' });

    const requestedDays = Math.max(1, Math.min(MAX_TTL_DAYS,
      Math.round(Number((req.body && req.body.ttlDays) || DEFAULT_TTL_DAYS))));
    const rotate = !!(req.body && req.body.rotate);

    const now = Date.now();
    const expired = order.approvalTokenExpiresAt && order.approvalTokenExpiresAt.getTime() < now;

    if (rotate || expired || !order.approvalToken) {
      order.approvalToken = crypto.randomBytes(16).toString('hex');
      order.approvalTokenExpiresAt = new Date(now + requestedDays * 24 * 60 * 60 * 1000);
      await order.save();
    } else if (req.body && req.body.ttlDays) {
      // Reuse the token but bump expiry to the new TTL.
      order.approvalTokenExpiresAt = new Date(now + requestedDays * 24 * 60 * 60 * 1000);
      await order.save();
    }

    res.json({
      token: order.approvalToken,
      projectId: order._id,
      expiresAt: order.approvalTokenExpiresAt,
    });
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
  if (order.approvalTokenExpiresAt && order.approvalTokenExpiresAt.getTime() < Date.now()) return null;
  return order;
}

// Best-effort admin notification. Logs and swallows errors so a stuck SMTP
// can't break a client's approval click.
async function notifyAdmin(subject, body) {
  if (!NOTIFY_EMAIL) return;
  try {
    await sendEmail({ to: NOTIFY_EMAIL, subject, html: body });
  } catch (e) {
    console.error('[approval] notifyAdmin failed:', e.message);
  }
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

    // Reduce approvalEvents to a single "current status" the client UI uses
    // for the persistent locked state on reload (so re-opening the link after
    // approving still shows "approved", not the buttons again).
    const events = order.approvalEvents || [];
    const lastTerminal = [...events].reverse().find(e => e.kind === 'approved' || e.kind === 'requested_changes');
    const currentStatus = lastTerminal ? lastTerminal.kind : 'pending';

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
        confirmation:         order.confirmation,
        orderDate:            order.orderDate,
        approvalStatus:       currentStatus,
        approvalAt:           lastTerminal ? lastTerminal.at : null,
        approvalMessage:      lastTerminal ? lastTerminal.message : '',
        approvalExpiresAt:    order.approvalTokenExpiresAt,
      },
      mockups,
      logo: logo ? logo.imageDataUrl : null,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// Stop accepting actions once the client has either approved or requested
// changes. Reopening the link should show the locked state, not re-let them
// flip-flop.
function _alreadyDecided(order) {
  const events = order.approvalEvents || [];
  return events.some(e => e.kind === 'approved' || e.kind === 'requested_changes');
}

// POST /api/public/projects/:id/approve?token=... — client approval action
const publicApprove = async (req, res) => {
  try {
    const order = await _loadProjectByToken(req.params.id, req.query.token);
    if (!order) return res.status(404).json({ message: 'Not found or invalid link.' });
    if (_alreadyDecided(order)) {
      return res.status(409).json({ message: 'This project has already been approved or sent for changes.' });
    }
    const update = {
      $push: { approvalEvents: { kind: 'approved', message: '', at: new Date() } },
    };
    // Only auto-bump status if currently quoted (don't override a manual placed/in_production)
    if (order.status === 'quoted') update.$set = { status: 'approved' };
    await Order.updateOne({ _id: order._id }, update);

    notifyAdmin(
      `[Joint Printing] Approved — ${order.companyName || order.clientName || 'Project'} (#${order.projectNumber || ''})`,
      `<p><strong>${order.companyName || order.clientName || 'A client'}</strong> approved project #${order.projectNumber || ''}.</p>` +
      `<p>Total: $${(order.totalValue || 0).toFixed(2)}</p>` +
      `<p>Open it in the Order Tracker to keep things moving.</p>`,
    );

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
    if (_alreadyDecided(order)) {
      return res.status(409).json({ message: 'This project has already been approved or sent for changes.' });
    }
    const message = String((req.body && req.body.message) || '').slice(0, 2000);
    await Order.updateOne(
      { _id: order._id },
      { $push: { approvalEvents: { kind: 'requested_changes', message, at: new Date() } } },
    );

    notifyAdmin(
      `[Joint Printing] Changes requested — ${order.companyName || order.clientName || 'Project'} (#${order.projectNumber || ''})`,
      `<p><strong>${order.companyName || order.clientName || 'A client'}</strong> requested changes on project #${order.projectNumber || ''}.</p>` +
      (message ? `<blockquote style="border-left:3px solid #ccc;padding-left:10px;color:#444">${message.replace(/</g,'&lt;').replace(/\n/g,'<br>')}</blockquote>` : '') +
      `<p>Open it in the Order Tracker to respond.</p>`,
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/:id/approval-link/send
// Body: { email, ttlDays?, rotate?, frontendOrigin? }
// Mints a token (rotating to expire any older link) and emails the link
// directly to the client. The frontendOrigin is supplied by the browser
// since the backend doesn't know the public URL it's hosted under.
const sendApprovalLink = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Project not found' });

    const email = String((req.body && req.body.email) || '').trim();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ message: 'A valid email address is required.' });
    }
    const ttlDays = Math.max(1, Math.min(MAX_TTL_DAYS,
      Math.round(Number((req.body && req.body.ttlDays) || DEFAULT_TTL_DAYS))));
    const rotate = req.body && req.body.rotate !== false;   // default rotate=true
    const frontendOrigin = String((req.body && req.body.frontendOrigin) || '').replace(/\/+$/, '');
    if (!frontendOrigin || !/^https?:\/\//i.test(frontendOrigin)) {
      return res.status(400).json({ message: 'frontendOrigin is required.' });
    }

    const now = Date.now();
    const expired = order.approvalTokenExpiresAt && order.approvalTokenExpiresAt.getTime() < now;
    if (rotate || expired || !order.approvalToken) {
      order.approvalToken = crypto.randomBytes(16).toString('hex');
    }
    order.approvalTokenExpiresAt = new Date(now + ttlDays * 24 * 60 * 60 * 1000);
    await order.save();

    const url = `${frontendOrigin}/approve/${order._id}?token=${order.approvalToken}`;
    const expiry = order.approvalTokenExpiresAt.toLocaleString();
    const greeting = order.clientName ? `Hi ${String(order.clientName).split(/\s+/)[0]},` : 'Hi,';
    const projectLabel = order.companyName || order.clientName || `Project #${order.projectNumber || ''}`;
    const html = `
      <p>${greeting}</p>
      <p>Your mockups + quote for <strong>${String(projectLabel).replace(/</g,'&lt;')}</strong> are ready to review.</p>
      <p><a href="${url}" style="display:inline-block;background:#1a3d2b;color:#fff;font-weight:700;padding:10px 20px;border-radius:6px;text-decoration:none">Open your approval page</a></p>
      <p style="color:#666;font-size:12px">Or copy this link: <a href="${url}">${url}</a></p>
      <p style="color:#999;font-size:11px">This link expires ${expiry}.</p>
      <p style="color:#999;font-size:11px">— Joint Printing</p>
    `;

    try {
      await sendEmail({
        to: email,
        subject: `${projectLabel} — proofs ready for your approval`,
        html,
      });
    } catch (e) {
      return res.status(500).json({ message: `Email send failed: ${e.message}` });
    }

    res.json({
      ok: true,
      sentTo: email,
      url,
      expiresAt: order.approvalTokenExpiresAt,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

module.exports = {
  ensureApprovalToken,
  sendApprovalLink,
  publicGetProject, publicApprove, publicRequestChanges,
};
