const crypto = require('crypto');
const Order = require('../models/Order');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const ClientLogo = require('../models/ClientLogo');
const sendEmail = require('../utils/sendEmail');

const DEFAULT_TTL_DAYS = 7;
const MAX_TTL_DAYS     = 365;

// Default order-tracking timeline. The client sees these (less any with
// hidden=true) on the same approval link they used to approve. Admin can
// rename labels, hide irrelevant steps, or add custom ones from the
// Order Tracker. Keep the ids stable — they're how the UI knows which
// step is which when rendering icons and the auto-tick on approval.
const DEFAULT_TRACKING_STEPS = () => ([
  { id: 'confirmation_approved', label: 'Confirmation approved', completedAt: null, note: '', hidden: false },
  { id: 'order_paid',            label: 'Order paid',            completedAt: null, note: '', hidden: false },
  { id: 'blanks_shipping',       label: 'Blanks shipping',       completedAt: null, note: '', hidden: false },
  { id: 'blanks_at_printer',     label: 'Blanks at the printer', completedAt: null, note: '', hidden: false },
  { id: 'on_the_way',            label: 'On the way to you',     completedAt: null, note: '', hidden: false },
  { id: 'arrived',               label: 'Arrived',               completedAt: null, note: '', hidden: false },
]);

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
// Returns one of:
//   { ok: true, order }          — valid, not expired
//   { ok: false, reason: 'expired' }  — token matches but past expiry
//   { ok: false, reason: 'invalid' }  — missing or wrong token / project gone
async function _loadProjectByToken(projectId, token) {
  if (!projectId || !token) return { ok: false, reason: 'invalid' };
  const order = await Order.findById(projectId).lean();
  if (!order) return { ok: false, reason: 'invalid' };
  if (!order.approvalToken || order.approvalToken !== token) return { ok: false, reason: 'invalid' };
  if (order.approvalTokenExpiresAt && order.approvalTokenExpiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'expired', expiresAt: order.approvalTokenExpiresAt };
  }
  return { ok: true, order };
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
    const lookup = await _loadProjectByToken(req.params.id, req.query.token);
    if (!lookup.ok) {
      if (lookup.reason === 'expired') {
        return res.status(410).json({ message: 'This approval link has expired.', reason: 'expired', expiresAt: lookup.expiresAt });
      }
      return res.status(404).json({ message: 'This link is invalid or no longer available.', reason: 'invalid' });
    }
    const order = lookup.order;

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

    // Strip hidden steps before sending to the client — admin uses
    // hidden=true to keep a step in their own view but suppress it from
    // the public timeline (e.g. when blank vendor and printer are the
    // same place, one of those two steps is hidden).
    const trackingSteps = ((order.tracking && order.tracking.steps) || [])
      .filter(s => !s.hidden)
      .map(s => ({
        id: s.id, label: s.label,
        completedAt: s.completedAt || null,
        note: s.note || '',
      }));

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
        tracking:             { steps: trackingSteps },
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
    const lookup = await _loadProjectByToken(req.params.id, req.query.token);
    if (!lookup.ok) {
      if (lookup.reason === 'expired') return res.status(410).json({ message: 'This approval link has expired — ask us for a new one.', reason: 'expired' });
      return res.status(404).json({ message: 'This link is invalid or no longer available.', reason: 'invalid' });
    }
    const order = lookup.order;
    if (_alreadyDecided(order)) {
      return res.status(409).json({ message: 'This project has already been approved or sent for changes.' });
    }
    const now = new Date();
    const update = {
      $push: { approvalEvents: { kind: 'approved', message: '', at: now } },
    };
    // Initialize tracking on first approval. If admin already pre-populated
    // tracking.steps from the Order Tracker we just tick off the
    // confirmation_approved step instead of clobbering their setup. The
    // approval timestamp is what shows on the client timeline as "step 1
    // complete" — that's the reassurance moment the user wanted.
    const existingSteps = (order.tracking && order.tracking.steps) || [];
    const set = {};
    if (order.status === 'quoted') set.status = 'approved';
    if (existingSteps.length === 0) {
      const steps = DEFAULT_TRACKING_STEPS();
      steps[0].completedAt = now;   // confirmation_approved
      set['tracking.steps'] = steps;
    } else {
      // Tick the confirmation_approved step if it exists and isn't already done.
      const updatedSteps = existingSteps.map(s => {
        if (s.id === 'confirmation_approved' && !s.completedAt) {
          return { ...s, completedAt: now };
        }
        return s;
      });
      set['tracking.steps'] = updatedSteps;
    }
    update.$set = set;
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
    const lookup = await _loadProjectByToken(req.params.id, req.query.token);
    if (!lookup.ok) {
      if (lookup.reason === 'expired') return res.status(410).json({ message: 'This approval link has expired — ask us for a new one.', reason: 'expired' });
      return res.status(404).json({ message: 'This link is invalid or no longer available.', reason: 'invalid' });
    }
    const order = lookup.order;
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

// PATCH /api/orders/:id/tracking — admin updates the tracking steps array
// (rename, reorder, hide, add custom, set completedAt). Single endpoint that
// takes the full steps array; simpler for the UI than per-step mutators and
// the array is small.
const updateTracking = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Project not found' });

    const incoming = (req.body && req.body.steps) || [];
    if (!Array.isArray(incoming)) {
      return res.status(400).json({ message: 'steps must be an array' });
    }

    // Sanitize each step. Reject anything weird so a malformed UI request
    // can't poison the doc. id is required (UI generates a stable one for
    // custom steps), label is whatever the admin typed, completedAt is
    // either a Date-parseable string or null.
    const cleaned = incoming.map((s, idx) => {
      const id = String(s.id || '').trim() || `custom_${idx}`;
      const label = String(s.label || '').slice(0, 80);
      let completedAt = null;
      if (s.completedAt) {
        const d = new Date(s.completedAt);
        if (!isNaN(d.getTime())) completedAt = d;
      }
      return {
        id,
        label,
        completedAt,
        note: String(s.note || '').slice(0, 500),
        hidden: !!s.hidden,
      };
    });

    if (!order.tracking) order.tracking = {};
    order.tracking.steps = cleaned;
    await order.save();
    res.json({ ok: true, tracking: { steps: order.tracking.steps } });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/:id/tracking/init — pre-populate the default tracking
// steps for projects that were approved before this feature existed. Idempotent:
// if steps already exist it returns them unchanged so the admin can't accidentally
// wipe a populated timeline.
const initTracking = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Project not found' });
    const existing = (order.tracking && order.tracking.steps) || [];
    if (existing.length > 0) {
      return res.json({ ok: true, tracking: { steps: existing }, initialized: false });
    }
    if (!order.tracking) order.tracking = {};
    order.tracking.steps = DEFAULT_TRACKING_STEPS();
    await order.save();
    res.json({ ok: true, tracking: { steps: order.tracking.steps }, initialized: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

module.exports = {
  ensureApprovalToken,
  sendApprovalLink,
  publicGetProject, publicApprove, publicRequestChanges,
  updateTracking, initTracking,
  DEFAULT_TRACKING_STEPS,
};
