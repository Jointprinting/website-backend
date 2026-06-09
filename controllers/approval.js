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
    const expired = order.approvalTokenExpiresAt && order.approvalTokenExpiresAt.getTime() < now;

    if (rotate || expired || !order.approvalToken) {
      order.approvalToken = crypto.randomBytes(16).toString('hex');
      order.approvalTokenExpiresAt = new Date(now + requestedDays * 24 * 60 * 60 * 1000);
      // Re-share = fresh approval cycle. Bump the supersede timestamp so
      // the previously-approved client lock doesn't carry over and block
      // the re-approval. Prior approvalEvents stay in history; they're
      // just no longer treated as "the current state".
      order.approvalSupersededAt = new Date(now);
      // Fresh cycle = fresh guest list; the old links no longer resolve.
      if (rotate) order.approvalRecipients = [];
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
      recipients: order.approvalRecipients || [],
      approvalStatus: _currentApprovalStatus(order),
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

    // Log the view (best-effort, throttled — only log if last event isn't a recent
    // view). Skipped for admin "preview as client" (?preview=1) so the owner
    // double-checking the page never shows up as a client view.
    const last = (order.approvalEvents || []).slice(-1)[0];
    const recentView = last && last.kind === 'viewed' && (Date.now() - new Date(last.at).getTime() < 5 * 60 * 1000);
    if (!recentView && !req.query.preview) {
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
        approvalBy:           cur.by || '',
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
    by:      lastTerminal ? (lastTerminal.by || '') : '',
  };
}

// Atomically record a terminal decision (approved / requested_changes) ONLY if
// none already exists in the current cycle (anything newer than
// approvalSupersededAt). Returns true if THIS call recorded it, false if it lost
// the race. The condition lives in the query filter, so check + write are one
// atomic document update — two people clicking at the same instant (one approve,
// one request-changes) resolve to exactly one winner, never a contradictory mix.
async function _recordDecisionIfFirst(order, token, event, set) {
  const cutoff = order.approvalSupersededAt ? new Date(order.approvalSupersededAt) : new Date(0);
  const filter = {
    _id: order._id,
    approvalToken: token,
    approvalEvents: {
      $not: { $elemMatch: { kind: { $in: ['approved', 'requested_changes'] }, at: { $gt: cutoff } } },
    },
  };
  const update = { $push: { approvalEvents: event } };
  if (set && Object.keys(set).length) update.$set = set;
  const result = await Order.updateOne(filter, update);
  return (result.matchedCount ?? result.n ?? 0) > 0;
}

// 409 helper: re-read the order and tell the client which decision already
// stands, so the page can lock gracefully (and warmly) instead of erroring.
async function _alreadyDecidedResponse(res, orderId) {
  const fresh = await Order.findById(orderId).lean();
  const cur = fresh ? _currentApprovalStatus(fresh) : { status: 'approved', by: '', at: null };
  const who = cur.by ? ` by ${cur.by}` : '';
  const message = cur.status === 'requested_changes'
    ? `Someone on your team just sent this back with a few notes${who}, so we've paused approval for now. If that wasn't meant to happen, reply to our email and we'll get it sorted.`
    : `Good news — this was just approved${who}. You're all set; nothing else to do here.`;
  return res.status(409).json({ message, reason: 'already_decided', decision: cur.status, by: cur.by, at: cur.at });
}

// Escape user-supplied text before dropping it into a notification email.
function _esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Revenue + COGS the client actually approved = the confirmation page's item
// rows (qty × unitPrice) plus custom add-on lines; COGS from each item's
// internal unitCost. Mirrors orders.js _confirmationTotals and the frontend
// _shared.js — the quoter total sums every alternative option and is NOT what
// the client bought, so the approval notification must use this instead.
function _confirmationTotals(conf) {
  if (!conf || !Array.isArray(conf.items)) return { revenue: 0, cogs: 0 };
  let revenue = conf.items.reduce((s, it) =>
    s + (it.sizes || []).reduce((ss, sz) => ss + (Number(sz.qty) || 0) * (Number(sz.unitPrice) || 0), 0), 0);
  (conf.customLines || []).forEach((l) => {
    revenue += l.isPercent ? revenue * (Number(l.amount) || 0) / 100 : (Number(l.amount) || 0);
  });
  const cogs = conf.items.reduce((s, it) => {
    const qty = (it.sizes || []).reduce((q, sz) => q + (Number(sz.qty) || 0), 0);
    return s + qty * (Number(it.unitCost) || 0);
  }, 0);
  return { revenue, cogs };
}

// "Who acted" line for the admin notification: prefer the name + email the
// client typed; fall back to the company/client on file.
function _actorLine(by, email, order) {
  if (by) return email ? `${by} (${email})` : by;
  return email || order.companyName || order.clientName || 'A client';
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
    const by    = String((req.body && req.body.name)  || '').trim().slice(0, 120);
    const email = String((req.body && req.body.email) || '').trim().slice(0, 200);
    const now = new Date();

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
      set['tracking.steps'] = existingSteps.map(s =>
        (s.id === 'confirmation_approved' && !s.completedAt) ? { ...s, completedAt: now } : s);
    }

    // Approval finalizes the order's money from the APPROVED confirmation. The
    // quoter total ($4,017 in the bug report) sums every alternative option;
    // the client only buys what's on the confirmation. Write those back so the
    // order, dashboards, and this email all agree. Guarded so a confirmation
    // with no priced items can't zero a real number.
    const { revenue: confRevenue, cogs: confCogs } = _confirmationTotals(order.confirmation);
    if (confRevenue > 0) set.totalValue = confRevenue;
    if (confCogs > 0)    set.cogs = confCogs;

    // Atomic first-decision-wins. The filter only matches while NO approval /
    // change-request exists in the CURRENT cycle, so when two people on the
    // shared link race (one approves, one requests changes), exactly one write
    // lands — the document update is atomic. No contradictory half-states.
    const decided = await _recordDecisionIfFirst(order, req.query.token, {
      kind: 'approved', message: '', by, email, at: now,
    }, set);
    if (!decided) return _alreadyDecidedResponse(res, order._id);

    const approvedTotal = confRevenue > 0 ? confRevenue : (Number(order.totalValue) || 0);
    const recips = (order.approvalRecipients || []).map(r => r.email).filter(Boolean);
    notifyAdminAndLog(
      order._id,
      `[Joint Printing] Approved — ${order.companyName || order.clientName || 'Project'} (#${order.projectNumber || ''})`,
      `<p><strong>${_esc(_actorLine(by, email, order))}</strong> approved project #${order.projectNumber || ''}.</p>` +
      (order.companyName ? `<p style="color:#555">${_esc(order.companyName)}</p>` : '') +
      `<p>Total: $${approvedTotal.toFixed(2)}</p>` +
      (recips.length ? `<p style="color:#888;font-size:12px">Approval link was shared with: ${recips.map(_esc).join(', ')}</p>` : '') +
      `<p>Open it in the Order Tracker to keep things moving.</p>`,
      'Client approved, but the email notification to you failed to send. Check your email settings.',
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
    const by    = String((req.body && req.body.name)  || '').trim().slice(0, 120);
    const email = String((req.body && req.body.email) || '').trim().slice(0, 200);
    const message = String((req.body && req.body.message) || '').slice(0, 2000);

    // Same atomic first-decision-wins guard as approve — if this loses the race
    // to an approval that landed a moment earlier, we don't double-record.
    const decided = await _recordDecisionIfFirst(order, req.query.token, {
      kind: 'requested_changes', message, by, email, at: new Date(),
    }, null);
    if (!decided) return _alreadyDecidedResponse(res, order._id);

    const recips = (order.approvalRecipients || []).map(r => r.email).filter(Boolean);
    notifyAdminAndLog(
      order._id,
      `[Joint Printing] Changes requested — ${order.companyName || order.clientName || 'Project'} (#${order.projectNumber || ''})`,
      `<p><strong>${_esc(_actorLine(by, email, order))}</strong> requested changes on project #${order.projectNumber || ''}.</p>` +
      (order.companyName ? `<p style="color:#555">${_esc(order.companyName)}</p>` : '') +
      (message ? `<blockquote style="border-left:3px solid #ccc;padding-left:10px;color:#444">${_esc(message).replace(/\n/g,'<br>')}</blockquote>` : '') +
      (recips.length ? `<p style="color:#888;font-size:12px">Approval link was shared with: ${recips.map(_esc).join(', ')}</p>` : '') +
      `<p>Open it in the Order Tracker to respond.</p>`,
      'Client requested changes, but the email notification to you failed to send. Check your email (SendGrid) settings.',
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/orders/:id/approval-link/send
// Body: { emails?: string[], email?: string, ttlDays?, rotate?, frontendOrigin? }
// Emails the approval link to one OR MORE people. Everyone gets the SAME link —
// it's a single shared "hub" token — so adding a person later never breaks the
// people already invited. We REUSE the existing token by default; we only mint a
// fresh one (which starts a new approval cycle and clears the guest list) when
// there's no usable token, it's expired, or the admin explicitly asks (rotate).
const sendApprovalLink = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Project not found' });

    // Accept a single `email` (back-compat) and/or an `emails` array. Trim,
    // validate, dedupe case-insensitively.
    const raw = []
      .concat(Array.isArray(req.body && req.body.emails) ? req.body.emails : [])
      .concat(req.body && req.body.email ? [req.body.email] : []);
    const seen = new Set();
    const emails = [];
    const invalid = [];
    raw.forEach((e) => {
      const addr = String(e || '').trim();
      if (!addr) return;
      const key = addr.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      if (/^\S+@\S+\.\S+$/.test(addr)) emails.push(addr); else invalid.push(addr);
    });
    if (emails.length === 0) {
      return res.status(400).json({
        message: invalid.length ? `Not a valid email: ${invalid.join(', ')}` : 'At least one valid email address is required.',
      });
    }

    const ttlDays = Math.max(1, Math.min(MAX_TTL_DAYS,
      Math.round(Number((req.body && req.body.ttlDays) || DEFAULT_TTL_DAYS))));
    // Default REUSE (rotate=false) so the hub link is stable. Only the admin
    // explicitly choosing "start fresh" passes rotate:true.
    const wantsRotate = !!(req.body && req.body.rotate);
    const frontendOrigin = String((req.body && req.body.frontendOrigin) || '').replace(/\/+$/, '');
    if (!frontendOrigin || !/^https?:\/\//i.test(frontendOrigin)) {
      return res.status(400).json({ message: 'frontendOrigin is required.' });
    }

    const now = Date.now();
    const expired = order.approvalTokenExpiresAt && order.approvalTokenExpiresAt.getTime() < now;
    const rotated = wantsRotate || expired || !order.approvalToken;
    if (rotated) {
      order.approvalToken = crypto.randomBytes(16).toString('hex');
      // Fresh token = fresh approval cycle. Prior approved/requested_changes
      // events become historical (see _currentApprovalStatus), and the guest
      // list resets since the old links no longer work.
      order.approvalSupersededAt = new Date(now);
      order.approvalRecipients = [];
    }
    order.approvalTokenExpiresAt = new Date(now + ttlDays * 24 * 60 * 60 * 1000);

    const url = `${frontendOrigin}/approve/${order._id}?token=${order.approvalToken}`;
    const expiry = order.approvalTokenExpiresAt.toLocaleString();
    const projectLabel = order.companyName || order.clientName || `Project #${order.projectNumber || ''}`;
    const safeLabel = String(projectLabel).replace(/</g, '&lt;');
    // Greet by first name only when there's a single, presumably-the-client
    // recipient — otherwise a neutral, still-friendly "Hi there,".
    const greeting = (emails.length === 1 && order.clientName)
      ? `Hi ${String(order.clientName).split(/\s+/)[0]},`
      : 'Hi there,';
    const html = `
      <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#222;line-height:1.55">
        <p>${greeting}</p>
        <p>Thanks so much for working with us on <strong>${safeLabel}</strong> — we're genuinely excited to make this for you.</p>
        <p>Your proof is ready to look over. Have a peek whenever you get a minute: if it all looks good you can approve it right on the page, and if anything needs a tweak just leave us a note there — no rush at all.</p>
        <p style="margin:22px 0">
          <a href="${url}" style="display:inline-block;background:#1a3d2b;color:#fff;font-weight:700;padding:11px 22px;border-radius:6px;text-decoration:none">Review your proof</a>
        </p>
        <p style="color:#666;font-size:12px">Or paste this link into your browser:<br><a href="${url}" style="color:#1a3d2b">${url}</a></p>
        <p style="color:#999;font-size:11px">This link stays live until ${expiry}. Feel free to share it with anyone else on your side who should weigh in — it's the same page for everyone.</p>
        <p style="color:#444;font-size:13px;margin-top:20px">Thanks again,<br>The Joint Printing team</p>
      </div>
    `;

    // Send to each recipient. One bad address shouldn't sink the rest.
    const sentTo = [];
    const failed = [];
    for (const to of emails) {
      try {
        await sendEmail({ to, subject: `Your proof for ${projectLabel} is ready to look over`, html });
        sentTo.push(to);
      } catch (e) {
        failed.push({ email: to, error: e.message });
      }
    }

    // Update the guest list (dedupe by email, keep the earliest sentAt).
    const recMap = new Map((order.approvalRecipients || []).map(r => [String(r.email).toLowerCase(), r]));
    sentTo.forEach((to) => {
      const key = to.toLowerCase();
      if (!recMap.has(key)) recMap.set(key, { email: to, sentAt: new Date() });
    });
    order.approvalRecipients = Array.from(recMap.values());

    if (sentTo.length > 0) {
      order.activity = order.activity || [];
      order.activity.push({
        kind: 'approval_shared', actor: 'admin',
        message: `Shared approval link with ${sentTo.join(', ')}`,
        meta: { recipients: sentTo, rotated },
        at: new Date(),
      });
    }
    await order.save();

    // Every send failed — surface it (the token/expiry changes are still saved,
    // so a retry can reuse the same link).
    if (sentTo.length === 0) {
      return res.status(502).json({
        message: `Couldn't send the email${failed.length > 1 ? 's' : ''}: ${failed.map(f => f.error).join('; ')}`,
        failed,
      });
    }

    res.json({
      ok: true,
      url,
      expiresAt: order.approvalTokenExpiresAt,
      sentTo,
      failed,
      recipients: order.approvalRecipients,
      rotated,
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
