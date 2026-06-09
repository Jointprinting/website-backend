const crypto = require('crypto');
const Order = require('../models/Order');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const ClientLogo = require('../models/ClientLogo');
const sendEmail = require('../utils/sendEmail');

const DEFAULT_TTL_DAYS = 7;
const MAX_TTL_DAYS     = 365;

// Once a client approves, their link doubles as the order-tracking page, so
// it must outlive the original share TTL. It stays usable for the whole
// production run and only goes dead this many days after the order finishes
// (every visible tracking step completed).
const POST_FINISH_GRACE_DAYS = 7;

// Default order-tracking timeline. The client sees these (less any with
// hidden=true) on the same approval link they used to approve. Admin can
// rename labels, hide irrelevant steps, or add custom ones from the
// Order Tracker. Keep the ids stable — they're how the UI knows which
// step is which when rendering icons and the auto-tick on approval.
const DEFAULT_TRACKING_STEPS = () => ([
  { id: 'confirmation_approved', label: 'Confirmation approved', completedAt: null, note: '', hidden: false, link: '' },
  { id: 'order_paid',            label: 'Order paid',            completedAt: null, note: '', hidden: false, link: '' },
  { id: 'blanks_shipping',       label: 'Blanks shipping',       completedAt: null, note: '', hidden: false, link: '' },
  { id: 'blanks_at_printer',     label: 'Blanks at the printer', completedAt: null, note: '', hidden: false, link: '' },
  { id: 'on_the_way',            label: 'On the way to you',     completedAt: null, note: '', hidden: false, link: '' },
  { id: 'arrived',               label: 'Arrived',               completedAt: null, note: '', hidden: false, link: '' },
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
    // _linkExpired (not raw TTL) so that merely opening the share dialog
    // doesn't rotate away a link the client is still using to track an
    // approved order.
    const expired = _linkExpired(order);

    if (rotate || expired || !order.approvalToken) {
      order.approvalToken = crypto.randomBytes(16).toString('hex');
      order.approvalTokenExpiresAt = new Date(now + requestedDays * 24 * 60 * 60 * 1000);
      // Re-share = fresh approval cycle. Bump the supersede timestamp so
      // the previously-approved client lock doesn't carry over and block
      // the re-approval. Prior approvalEvents stay in history; they're
      // just no longer treated as "the current state".
      order.approvalSupersededAt = new Date(now);
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
  if (_linkExpired(order)) {
    return { ok: false, reason: 'expired', expiresAt: order.approvalTokenExpiresAt };
  }
  return { ok: true, order };
}

// The share TTL only governs the pre-approval window. After the client
// approves (in the current cycle — a re-share resets this), the link lives
// on as their tracking page until POST_FINISH_GRACE_DAYS after the order
// finishes. "Finished" = every non-hidden tracking step has completedAt;
// finish time is the latest of those timestamps.
function _linkExpired(order) {
  const expiresAt = order.approvalTokenExpiresAt;
  if (!expiresAt || expiresAt.getTime() >= Date.now()) return false;

  if (_currentApprovalStatus(order).status !== 'approved') return true;

  const steps = ((order.tracking && order.tracking.steps) || []).filter(s => !s.hidden);
  const done = steps.filter(s => s.completedAt);
  if (steps.length === 0 || done.length < steps.length) return false; // still in progress
  const finishedAt = Math.max(...done.map(s => new Date(s.completedAt).getTime()));
  return Date.now() > finishedAt + POST_FINISH_GRACE_DAYS * 24 * 60 * 60 * 1000;
}

// Best-effort admin notification. Logs and swallows errors so a stuck SMTP
// can't break a client's approval click.
async function notifyAdmin(subject, body) {
  if (!NOTIFY_EMAIL) return false;
  try {
    await sendEmail({ to: NOTIFY_EMAIL, subject, html: body });
    return true;
  } catch (e) {
    console.error('[approval] notifyAdmin failed:', e.message);
    return false;
  }
}

// Fire the admin email without blocking the client's response (a slow SMTP
// shouldn't delay the approval click). If it fails, drop a visible activity
// event on the order so the failure isn't silent — the admin sees it in the
// Order Tracker even though the email never arrived.
function notifyAdminAndLog(orderId, subject, body, failNote) {
  notifyAdmin(subject, body).then((ok) => {
    if (!ok) {
      Order.updateOne(
        { _id: orderId },
        { $push: { activity: { kind: 'notify_failed', actor: 'system', message: failNote, at: new Date() } } },
      ).catch(() => {});
    }
  });
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
    // Only return mockups that are actually IN the confirmation page the client
    // is reviewing — i.e. referenced by an item in order.confirmation.items.
    // Previously this returned everything in order.mockupNumbers, which is the
    // admin's full per-project library (early proofs, alternates, scrapped
    // versions). Clients were seeing the unfiltered pile.
    //
    // Fall back to order.mockupNumbers when no confirmation has been built yet
    // (legacy projects, pre-confirmation share links) so those keep working.
    const confItems = (order.confirmation && order.confirmation.items) || [];
    const confRefs = confItems
      .map(it => it && it.mockupNum)
      .filter(Boolean);
    const mockupRefs = confRefs.length > 0 ? confRefs : (order.mockupNumbers || []);
    const mockupItems = await StudioLibraryItem
      .find({ store: 'mockups' })
      .select('name pageState.mockupNum thumbnail data')
      .lean();
    const byNorm = {};
    mockupItems.forEach(m => {
      const k = norm(m.pageState && m.pageState.mockupNum);
      if (k) byNorm[k] = m;
    });
    // Preserve confirmation item order + dedupe (an item might be listed twice
    // in confirmation.items if the user added the same product as separate
    // line items for sizing — we still only want one tile per mockup).
    const seen = new Set();
    const mockups = mockupRefs
      .map(n => norm(n))
      .filter(k => { if (seen.has(k)) return false; seen.add(k); return true; })
      .map(k => byNorm[k])
      .filter(Boolean)
      .map(m => ({ name: m.name, thumbnail: m.thumbnail, back: m.data, mockupNum: m.pageState?.mockupNum }));

    const logo = await ClientLogo.findOne({ companyKey: order.companyKey }).select('imageDataUrl').lean();

    // Log the view (best-effort, throttled — only log if last event isn't a recent view)
    const last = (order.approvalEvents || []).slice(-1)[0];
    const recentView = last && last.kind === 'viewed' && (Date.now() - new Date(last.at).getTime() < 5 * 60 * 1000);
    if (!recentView) {
      await Order.updateOne({ _id: order._id },
        { $push: { approvalEvents: { kind: 'viewed', at: new Date() } } });
    }

    // Reduce approvalEvents to a single "current status" the client UI uses
    // for the persistent locked state on reload. Filtered by
    // approvalSupersededAt so a re-shared link doesn't keep showing the
    // previous "approved" lock — the client gets a fresh ask.
    const cur = _currentApprovalStatus(order);
    const currentStatus = cur.status;
    const lastTerminal = cur.status === 'pending' ? null : { at: cur.at, message: cur.message };

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
        link: s.link || '',
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
// changes IN THE CURRENT CYCLE. When admin re-shares the link with new
// confirmation content (approvalSupersededAt bumped), older approvals no
// longer lock the page so the client can approve the new version.
function _alreadyDecided(order) {
  const events = order.approvalEvents || [];
  const cutoff = order.approvalSupersededAt ? new Date(order.approvalSupersededAt).getTime() : 0;
  return events.some(e =>
    (e.kind === 'approved' || e.kind === 'requested_changes') &&
    new Date(e.at).getTime() > cutoff
  );
}

// Same cutoff applied when computing the "current status" the client sees on
// the public page. Without this, re-opening the link after a re-share would
// still render the old "approved" timeline instead of the new approval ask.
function _currentApprovalStatus(order) {
  const events = order.approvalEvents || [];
  const cutoff = order.approvalSupersededAt ? new Date(order.approvalSupersededAt).getTime() : 0;
  const lastTerminal = [...events].reverse().find(e =>
    (e.kind === 'approved' || e.kind === 'requested_changes') &&
    new Date(e.at).getTime() > cutoff
  );
  return {
    status: lastTerminal ? lastTerminal.kind : 'pending',
    at:     lastTerminal ? lastTerminal.at : null,
    message: lastTerminal ? lastTerminal.message : '',
  };
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

    notifyAdminAndLog(
      order._id,
      `[Joint Printing] Approved — ${order.companyName || order.clientName || 'Project'} (#${order.projectNumber || ''})`,
      `<p><strong>${order.companyName || order.clientName || 'A client'}</strong> approved project #${order.projectNumber || ''}.</p>` +
      `<p>Total: $${(order.totalValue || 0).toFixed(2)}</p>` +
      `<p>Open it in the Order Tracker to keep things moving.</p>`,
      'Client approved, but the email notification to you failed to send. Check your email (SendGrid) settings.',
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

    notifyAdminAndLog(
      order._id,
      `[Joint Printing] Changes requested — ${order.companyName || order.clientName || 'Project'} (#${order.projectNumber || ''})`,
      `<p><strong>${order.companyName || order.clientName || 'A client'}</strong> requested changes on project #${order.projectNumber || ''}.</p>` +
      (message ? `<blockquote style="border-left:3px solid #ccc;padding-left:10px;color:#444">${message.replace(/</g,'&lt;').replace(/\n/g,'<br>')}</blockquote>` : '') +
      `<p>Open it in the Order Tracker to respond.</p>`,
      'Client requested changes, but the email notification to you failed to send. Check your email (SendGrid) settings.',
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
    const expired = _linkExpired(order);
    if (rotate || expired || !order.approvalToken) {
      order.approvalToken = crypto.randomBytes(16).toString('hex');
      // Fresh token = fresh approval cycle. Prior approved/requested_changes
      // events are now historical, not the current state. See _alreadyDecided
      // and _currentApprovalStatus for how this is read.
      order.approvalSupersededAt = new Date(now);
    }
    order.approvalTokenExpiresAt = new Date(now + ttlDays * 24 * 60 * 60 * 1000);
    await order.save();

    const url = `${frontendOrigin}/approve/${order._id}?token=${order.approvalToken}`;
    const expiry = order.approvalTokenExpiresAt.toLocaleString();
    const greeting = order.clientName ? `Hi ${String(order.clientName).split(/\s+/)[0]},` : 'Hi,';
    const projectLabel = order.companyName || order.clientName || `Project #${order.projectNumber || ''}`;
    const safeLabel = String(projectLabel).replace(/</g,'&lt;');
    const html = `
      <p>${greeting}</p>
      <p>Your confirmation page for <strong>${safeLabel}</strong> is ready for review.</p>
      <p><a href="${url}" style="display:inline-block;background:#1a3d2b;color:#fff;font-weight:700;padding:10px 20px;border-radius:6px;text-decoration:none">Open your confirmation page</a></p>
      <p style="color:#666;font-size:12px">Or copy this link: <a href="${url}">${url}</a></p>
      <p style="color:#999;font-size:11px">This link expires ${expiry}. Once you approve, it stays active as your order-tracking page until a week after your order arrives.</p>
      <p style="color:#999;font-size:11px">— Joint Printing</p>
    `;

    try {
      await sendEmail({
        to: email,
        subject: `Your confirmation page for ${projectLabel} is ready for review`,
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
      // Only accept http(s) links — never javascript:, data:, etc. The
      // client renders these as <a target="_blank"> so anything else
      // would be a vector for funny stuff.
      let link = String(s.link || '').trim().slice(0, 500);
      if (link && !/^https?:\/\//i.test(link)) link = '';
      return {
        id,
        label,
        completedAt,
        note: String(s.note || '').slice(0, 500),
        hidden: !!s.hidden,
        link,
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
