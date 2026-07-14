const crypto = require('crypto');
const Order = require('../models/Order');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const ClientLogo = require('../models/ClientLogo');
const sendEmail = require('../utils/sendEmail');
const { nextNumber } = require('../utils/sequence');

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

// Deal pipeline auto-advance: sharing the quote/approval link moves the job's
// deal to 'quote_sent' (mirrors the delivered→won hook in orders.js — matched
// by the strongest link first, best-effort, never blocks the share). Fires from
// both the link mint (opening the share dialog = intent to share) and the
// email send; already-sent/closed deals are untouched.
async function markQuoteSent(order) {
  try {
    const Deal = require('../models/Deal');
    const or = [{ sourceOrderId: String(order._id) }];
    if (order.projectNumber) or.push({ projectNumber: order.projectNumber });
    if (order.orderNumber) or.push({ orderNumber: order.orderNumber });
    const r = await Deal.updateMany(
      { $or: or, stage: { $in: ['details_needed', 'quoting'] } },
      { $set: { stage: 'quote_sent', quoteSentAt: new Date() } },
    );
    if (r.modifiedCount) console.log(`[deals] quote shared for ${order.orderNumber || order.projectNumber} → ${r.modifiedCount} deal(s) at quote_sent`);
  } catch (e) {
    console.warn('[deals] quote-sent sync failed:', e.message);
  }
}

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
      // C1: clear the prior cycle's "options picked" gate too. Without this a
      // returning client whose last cycle reached the "building your
      // confirmation" interstitial is stranded there forever — optionsPickedAt
      // (and the accepted-line flags) from the old cycle keep the page in the
      // post-pick "building" state even though this is a brand-new share. Reset
      // it so a fresh link always lands on the current confirmation / picker.
      order.optionsPickedAt = null;
      // Fresh cycle = fresh guest list; the old links no longer resolve.
      if (rotate) order.approvalRecipients = [];
      await order.save();
    } else if (req.body && req.body.ttlDays) {
      // Reuse the token but bump expiry to the new TTL.
      order.approvalTokenExpiresAt = new Date(now + requestedDays * 24 * 60 * 60 * 1000);
      await order.save();
    }

    await markQuoteSent(order);

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

// One-time repair (run on boot; idempotent): legacy approval tokens minted
// before expiry existed carry approvalTokenExpiresAt: null — which the
// validator treats as "never expires", leaving those links public forever.
// Give each a finite fuse: 30 days from now, after which the normal machinery
// applies (an APPROVED order's link still gets the post-arrival grace + 180-day
// backstop, so no in-flight approval is cut off abruptly). Fills null only —
// re-running is a no-op.
async function expireLegacyApprovalTokens() {
  const r = await Order.updateMany(
    { approvalToken: { $nin: [null, ''] }, approvalTokenExpiresAt: null },
    { $set: { approvalTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } },
  );
  return r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
}

// One-time backfill for the confirmation PUBLISH GATE. Confirmations built BEFORE
// the gate existed have no `publishedAt`; without this they'd read as unpublished
// drafts and a client mid-review would be bounced to the "we're finalizing" screen.
// Stamp every EXISTING confirmation-with-content as already-published (using its own
// order date / last-updated time). Guarded to run exactly once (see server.js) so it
// can never stamp a NEW draft the owner hasn't pushed. Mirrors
// scripts/backfillConfirmationPublished.js so the owner never has to run a script.
async function backfillConfirmationPublished() {
  const r = await Order.updateMany(
    {
      $and: [
        { $or: [{ 'confirmation.items.0': { $exists: true } }, { 'confirmation.customLines.0': { $exists: true } }] },
        { $or: [{ 'confirmation.publishedAt': null }, { 'confirmation.publishedAt': { $exists: false } }] },
      ],
    },
    [{ $set: { 'confirmation.publishedAt': { $ifNull: ['$confirmation.orderDate', { $ifNull: ['$updatedAt', '$$NOW'] }] } } }],
  );
  return r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
}

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
    // Exception: once the client has APPROVED in the current cycle, this link
    // becomes their order-tracking page — it must stay alive until a week
    // after the order ARRIVES (tracking 'arrived' step), not the share TTL.
    const approved = _currentApprovalStatus(order).status === 'approved';
    const arrived = ((order.tracking && order.tracking.steps) || [])
      .find(st => st.id === 'arrived' && st.completedAt);
    // Cancelled projects close immediately — no reason to keep their pricing
    // page public. Otherwise the link lives until a week after 'arrived'; if
    // 'arrived' is never ticked, a finite backstop (180 days past the share
    // expiry) still closes it, so a link never stays public forever.
    const BACKSTOP_MS = 180 * 24 * 60 * 60 * 1000;
    const graceEnd = arrived
      ? new Date(arrived.completedAt).getTime() + 7 * 24 * 60 * 60 * 1000
      : order.approvalTokenExpiresAt.getTime() + BACKSTOP_MS;
    if (order.status === 'cancelled' || !(approved && Date.now() < graceEnd)) {
      return { ok: false, reason: 'expired', expiresAt: order.approvalTokenExpiresAt };
    }
  }
  return { ok: true, order };
}

// ── Public invoice / receipt downloads ────────────────────────────────────────
// Token-gated PDFs off the approved confirmation — the same airtight totals
// the client approved, faced as an invoice (payment line) or receipt (PAID
// banner). Receipt requires the order to actually be paid; invoice requires
// an approved confirmation (there is nothing to invoice before that).
function publicOrderDoc(docType) {
  const render = require('./confirmationPdf').orderDocPdf(docType);
  return async (req, res) => {
    try {
      const gate = await _loadProjectByToken(req.params.id, String(req.query.token || ''));
      if (!gate.ok) {
        return res.status(gate.reason === 'expired' ? 410 : 404)
          .json({ message: gate.reason === 'expired' ? 'This link has expired.' : 'Not found.' });
      }
      const order = gate.order;
      if (_currentApprovalStatus(order).status !== 'approved') {
        return res.status(400).json({ message: 'Available once the order is approved.' });
      }
      if (docType === 'receipt') {
        const paid = ((order.tracking && order.tracking.steps) || []).some((st) => st.id === 'order_paid' && st.completedAt);
        if (!paid) return res.status(400).json({ message: 'Available once the order is paid.' });
      }
      return render(req, res);
    } catch (e) {
      res.status(500).json({ message: 'Document failed.' });
    }
  };
}

// Who is acting, from the personal `r` tag the share email put in their link
// (base64url of the recipient email). Returns '' for hand-copied links or
// garbage values — never throws, never trusts more than an email shape.
function _recipientEmail(req) {
  try {
    const r = String((req.query && req.query.r) || '');
    if (!r || r.length > 400) return '';
    const decoded = Buffer.from(r, 'base64url').toString('utf8');
    return /^\S+@\S+\.\S+$/.test(decoded) && decoded.length <= 254 ? decoded : '';
  } catch (_) { return ''; }
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
      .select('name pageState.mockupNum thumbnail data extraViews')
      .lean();
    const byNorm = {};
    mockupItems.forEach(m => {
      const k = norm(m.pageState && m.pageState.mockupNum);
      if (k) byNorm[k] = m;
      // Fallback key: the picker stores the mockup NAME when an item has no
      // number — without this the builder shows an image but the client page
      // and PDF silently drop it.
      const nk = norm(m.name);
      if (nk && !byNorm[nk]) byNorm[nk] = m;
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
      // extraViews = pages 2+ of a multi-page mockup (e.g. the sideways
      // garment for shoulder prints) — the client sees every view.
      .map(m => ({ name: m.name, thumbnail: m.thumbnail, back: m.data, mockupNum: m.pageState?.mockupNum, extraViews: m.extraViews || [] }));

    const logo = await ClientLogo.findOne({ companyKey: order.companyKey }).select('imageDataUrl').lean();

    // Log the view (best-effort, throttled — only log if last event isn't a recent
    // view). Skipped for admin "preview as client" (?preview=1) so the owner
    // double-checking the page never shows up as a client view.
    const last = (order.approvalEvents || []).slice(-1)[0];
    const recentView = last && last.kind === 'viewed' && (Date.now() - new Date(last.at).getTime() < 5 * 60 * 1000);
    if (!recentView && !req.query.preview) {
      await Order.updateOne({ _id: order._id },
        { $push: { approvalEvents: { kind: 'viewed', email: _recipientEmail(req), at: new Date() } } });
    }

    // Reduce approvalEvents to a single "current status" the client UI uses
    // for the persistent locked state on reload. Filtered by
    // approvalSupersededAt so a re-shared link doesn't keep showing the
    // previous "approved" lock — the client gets a fresh ask.
    const cur = _currentApprovalStatus(order);
    const currentStatus = cur.status;
    const lastTerminal = cur.status === 'pending' ? null : { at: cur.at, message: cur.message };

    // C1: gate the "options picked" timestamp by the supersede cutoff exactly
    // like the terminal status above. The rotate/re-share paths now clear
    // optionsPickedAt, but an order superseded by some other path (or saved
    // before that fix shipped) could still carry a stale pickedAt — which would
    // strand a returning client on the "building your confirmation"
    // interstitial. Only report a pick that happened in the CURRENT cycle.
    const pickedAtCurrent = _pickedAtForCycle(order);

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

    // Client-safe quote lines: resolve the unit price server-side and strip
    // every internal field. Costs, markup, and supplier must NEVER reach the
    // public payload — anyone with the approval link can read the raw JSON.
    const safeQuoteLines = (order.quoteLines || []).map(l => {
      const n = (v) => Number(v) || 0;
      const qty = n(l.qty);
      const setupShip = n(l.setupCost) + n(l.shippingCost);
      const unitCogs = n(l.blankCost) + n(l.printCost) + (qty > 0 ? setupShip / qty : 0);
      return {
        qty,
        group:        l.group        || '',
        accepted:     !!l.accepted,
        styleCode:    l.styleCode    || '',
        description:  l.description  || '',
        color:        l.color        || '',
        printType:    l.printType    || '',
        printDetails: l.printDetails || '',
        unitPrice:    n(l.unitPrice) || +(unitCogs * (n(l.markup) || 1.4)).toFixed(2),
        // Optional lead time (weeks) shown to the client only when set (>0).
        turnaroundWeeks: n(l.turnaroundWeeks) || 0,
        // Public product page for this blank (owner-set, e.g. S&S Activewear).
        // The one supplier fact that IS client-facing — see the schema note;
        // costs/markup/supplier name stay stripped.
        productUrl:   l.supplierUrl || '',
        // Design preview for the option card: the line's uploaded image
        // (vendor-rendered items) or its studio mockup's thumbnail.
        image: l.image
          || (l.mockupNum && byNorm[norm(l.mockupNum)] && byNorm[norm(l.mockupNum)].thumbnail)
          || '',
      };
    });

    // Publish gate, applied to the money too: while the confirmation is an
    // unpublished DRAFT, the client must not see any of it — not the object, and
    // not the grand total it derives (order.totalValue becomes the confirmation
    // grandTotal on every autosave, incl. shipping + fee% + tax the owner is still
    // reviewing). During that window we send the QUOTE-derived total the client
    // actually picked and hide orderDate. Once published — or when there's no
    // confirmation at all (a legacy/imported order that legitimately shows a
    // total on the read-only approve screen) — the stored values pass through.
    const published = _confPublished(order.confirmation);
    const draftHidden = !published && _hasConfContent(order.confirmation);
    const publicTotalValue = draftHidden
      ? Order.computeQuoteTotals(order.quoteLines || []).totalValue
      : order.totalValue;

    res.json({
      project: {
        projectNumber:        order.projectNumber,
        orderNumber:          order.orderNumber,
        companyName:          order.companyName,
        clientName:           order.clientName,
        status:               order.status,
        totalValue:           publicTotalValue,
        items:                order.items,
        quoteLines:           safeQuoteLines,
        mockupNumbers:        order.mockupNumbers,
        confirmationMessage:  order.confirmationMessage,
        confirmationTerms:    order.confirmationTerms,
        // Publish gate: the client only receives the confirmation (and the flag
        // that advances their page to REVIEW+APPROVE) once the owner has pushed
        // it. While it's an unpublished draft, send an empty stub so neither the
        // stage machine nor a raw-JSON reader can surface the half-built doc.
        confirmation:         published ? _safeConfirmation(order.confirmation) : { items: [], customLines: [] },
        orderDate:            draftHidden ? null : order.orderDate,
        optionsPickedAt:      pickedAtCurrent,
        paymentMethod:        order.paymentMethod || '',
        hasConfirmation:      published,
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
    console.error('[approval] public handler failed:', e.message);
    res.status(500).json({ message: 'Something went wrong on our end — please try again.' });
  }
};

// C1 strand-gate (pure, testable): the client's "options picked" timestamp,
// but ONLY if it falls in the current approval cycle (newer than
// approvalSupersededAt). A pick from a superseded cycle returns null so a
// re-shared link never strands a returning client on the post-pick "building
// your confirmation" interstitial — they see the current confirmation/picker.
// Same supersede cutoff as _currentApprovalStatus, so the two never disagree.
function _pickedAtForCycle(order) {
  if (!order || !order.optionsPickedAt) return null;
  const cutoff = order.approvalSupersededAt ? new Date(order.approvalSupersededAt).getTime() : 0;
  return new Date(order.optionsPickedAt).getTime() > cutoff ? order.optionsPickedAt : null;
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
  // Revenue = the order's grand total, computed by the ONE canonical function so
  // the approval-written totalValue, the admin email, the PDF and the model's
  // stored total can never disagree. computeConfirmationTotals enforces the
  // double-tax guard (C3) and snaps to cents (H4); this path writes totalValue
  // via Order.updateOne (bypassing the model hooks), so delegating here is what
  // keeps the persisted total correct.
  const revenue = Order.computeConfirmationTotals(conf).grandTotal;
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

// Client-safe confirmation: the public payload must never carry internal
// margin data — items[].unitCost is the per-unit COST and printerName names
// the supplier. Everything the approval page renders stays.
function _safeConfirmation(conf) {
  if (!conf) return conf;
  const out = { ...conf };
  if (Array.isArray(out.items)) {
    out.items = out.items.map(it => {
      const { unitCost, printerName, ...rest } = (it && it.toObject ? it.toObject() : it) || {};
      return rest;
    });
  }
  return out;
}

// Local mirror of Order.hasConfirmationContent (lean docs, no model method).
function _hasConfContent(conf) {
  if (!conf) return false;
  return ((conf.items || []).length > 0) || ((conf.customLines || []).length > 0);
}

// The PUBLISH GATE (the owner's "buffer"): a confirmation is only live to the
// client once the owner has explicitly pushed it (confirmation.publishedAt set).
// Building/seeding/autosaving the draft must NOT flip the client's page — they
// stay on "we're finalizing your order" until this is true. Mirrors
// Order.confirmationIsPublished for lean docs.
function _confPublished(conf) {
  return _hasConfContent(conf) && !!(conf && conf.publishedAt);
}

// POST /api/public/projects/:id/select?token=... — the interactive quote
// stage. Body: { picks: [lineIndex, ...] }. The client picks ONE option per
// product group; standalone (ungrouped) lines are always part of the order.
// Marks the picked lines accepted and notifies the admin, whose confirmation
// builder seeds itself from the accepted lines. No confirmation is written
// here — content in order.confirmation flips the client page to the
// confirmation stage and switches order totals, which must only happen once
// the admin has actually built one. Re-picking stays open until then.
const publicSelectOptions = async (req, res) => {
  try {
    const lookup = await _loadProjectByToken(req.params.id, req.query.token);
    if (!lookup.ok) {
      if (lookup.reason === 'expired') return res.status(410).json({ message: 'This link has expired — ask us for a new one.', reason: 'expired' });
      return res.status(404).json({ message: 'This link is invalid or no longer available.', reason: 'invalid' });
    }

    // Validate + write against a FRESH doc, not the token-lookup snapshot —
    // an admin edit or a teammate's approve in between must win, not be
    // silently overwritten (the lean snapshot's line indexes may be stale).
    const doc = await Order.findById(lookup.order._id);
    if (!doc) return res.status(404).json({ message: 'Project not found.' });
    if (_currentApprovalStatus(doc).status !== 'pending') {
      return _alreadyDecidedResponse(res, doc._id);
    }
    // Block re-picking only once the owner has PUSHED the confirmation (it's live
    // for review). While it's still an unpublished draft the client may freely
    // change their picks from the waiting screen — the owner re-seeds before
    // pushing. Once published, changes go through "request changes" instead.
    if (_confPublished(doc.confirmation)) {
      return res.status(409).json({
        message: "Your confirmation page is ready to review — reload to see it. If you need to change something, use 'Request changes' there.",
        reason: 'confirmation_published',
      });
    }

    const lines = doc.quoteLines || [];
    const groups = [...new Set(lines.map(l => l.group).filter(Boolean))];
    const standaloneCount = lines.filter(l => !l.group).length;
    // A quote with no option-groups but real standalone lines is a valid
    // "accept this quote" — the client accepts and lands on the waiting screen
    // while the owner finalizes the confirmation (so EVERY quote routes through
    // the owner's confirmation, never a direct quote-approve). Only a truly empty
    // quote (no groups AND no standalone lines) has nothing to accept.
    if (groups.length === 0 && standaloneCount === 0) {
      return res.status(400).json({ message: 'This quote has no line items to accept yet.' });
    }
    const picksRaw = (req.body && req.body.picks) || [];
    const picks = Array.isArray(picksRaw) ? [...new Set(picksRaw.map(Number))] : [];
    if (!picks.every(i => Number.isInteger(i) && i >= 0 && i < lines.length && lines[i].group)) {
      return res.status(400).json({ message: 'Invalid selection — please refresh the page and try again.' });
    }
    // AT MOST one option per group. The client takes the options they want and
    // can skip whole groups entirely — a 10-option pitch where they only want 5
    // is a valid selection, not an error. Two picks in the same group (which
    // are alternatives, not add-ons) is the only invalid shape.
    for (const g of groups) {
      const inGroup = picks.filter(i => lines[i].group === g);
      if (inGroup.length > 1) {
        return res.status(400).json({ message: `Please choose just one option for "${g}" — or skip it.` });
      }
    }
    // The order can't be empty: require at least one picked option, unless the
    // quote carries always-included standalone lines that stand on their own.
    if (picks.length === 0 && standaloneCount === 0) {
      return res.status(400).json({ message: 'Pick at least one option to continue.' });
    }

    const email = String((req.body && req.body.email) || '').slice(0, 254).trim() || _recipientEmail(req);
    const now = new Date();
    const pickSet = new Set(picks);
    // A line is "accepted" (part of the committed order) if the client picked it
    // OR it's an always-included standalone line. Marking standalone lines here
    // is what tells the totals math the client has committed — so a selection of
    // "decline every group, keep only the standalone items" still books its real
    // value instead of reading as an un-picked $0 quote.
    lines.forEach((l, i) => { l.accepted = pickSet.has(i) || !l.group; });
    doc.markModified('quoteLines');
    doc.optionsPickedAt = now;
    const chosen = lines.filter(l => l.accepted || !l.group);
    const summary = chosen
      .map(l => `${l.group ? l.group + ': ' : ''}${l.description || l.styleCode || 'item'} × ${l.qty}`)
      .join(' · ');
    doc.approvalEvents.push({ kind: 'options_picked', message: summary, by: '', email, at: now });
    await doc.save();

    notifyAdminAndLog(
      doc._id,
      `[Joint Printing] Options picked — ${doc.companyName || doc.clientName || 'Project'} (#${doc.projectNumber || ''})`,
      `<p><strong>${_esc(email || doc.companyName || doc.clientName || 'Your client')}</strong> picked their options on project #${_esc(doc.projectNumber || '')}.</p>` +
      `<p>${_esc(summary)}</p>` +
      `<p>Open the confirmation builder — it fills in from their picks (product, quantity, unit price). Double-check the numbers, then hit <strong>Push to client</strong> to send it to their link for approval.</p>`,
      'Client picked options, but the email notification to you failed to send. Check your email (SendGrid) settings.',
    );

    res.json({ ok: true, pickedAt: now });
  } catch (e) {
    console.error('[approval] public handler failed:', e.message);
    res.status(500).json({ message: 'Something went wrong on our end — please try again.' });
  }
};

// POST /api/public/projects/:id/approve?token=... — client approval action
const publicApprove = async (req, res) => {
  try {
    const lookup = await _loadProjectByToken(req.params.id, req.query.token);
    if (!lookup.ok) {
      if (lookup.reason === 'expired') return res.status(410).json({ message: 'This approval link has expired — ask us for a new one.', reason: 'expired' });
      return res.status(404).json({ message: 'This link is invalid or no longer available.', reason: 'invalid' });
    }
    const order = lookup.order;

    // Server backstop for the invariant "the client can never approve a raw
    // quote directly": if this order carries a quote, approval is only allowed
    // once the owner has PUBLISHED a confirmation. This makes the server — not
    // just the frontend routing — the source of truth, so a stale/old-bundle tab
    // or a direct API call can't commit a bare quote. A truly quote-less order
    // (legacy/imported, no quoteLines) has no confirmation to build and approves
    // directly on the read-only screen, exactly as before.
    if ((order.quoteLines || []).length > 0 && !_confPublished(order.confirmation)) {
      return res.status(409).json({
        message: "Your confirmation isn't ready to approve yet — we're finalizing the details and you'll be able to approve here in a moment.",
        reason: 'confirmation_not_published',
      });
    }

    const by    = String((req.body && req.body.name)  || '').trim().slice(0, 120);
    const email = String((req.body && req.body.email) || '').trim().slice(0, 200) || _recipientEmail(req);
    // Payment method the client chose on the approval page (optional). Only 'cc'
    // or 'ach' are accepted; anything else is ignored (approval still proceeds).
    // Recorded for the owner — it does NOT change the confirmation's stored total.
    const payRaw = String((req.body && req.body.paymentMethod) || '').trim().toLowerCase();
    const paymentMethod = (payRaw === 'cc' || payRaw === 'ach') ? payRaw : '';
    // Version string of the "approval is final" notice the client saw on the
    // confirmation page (sent by the client app at approval). Stored so the
    // owner has a record the terms were presented. Capped + sanitized.
    const termsVersion = String((req.body && req.body.termsVersion) || '').trim().slice(0, 40);
    const now = new Date();

    // Initialize tracking on first approval. If admin already pre-populated
    // tracking.steps from the Order Tracker we just tick off the
    // confirmation_approved step instead of clobbering their setup. The
    // approval timestamp is what shows on the client timeline as "step 1
    // complete" — that's the reassurance moment the user wanted.
    const existingSteps = (order.tracking && order.tracking.steps) || [];
    const set = {};
    if (order.status === 'quoted') {
      set.status = 'approved';
      // Invoice # is assigned at approval (the import seed notes promise
      // this); the admin path does it in updateOrder, so client sign-off
      // has to do it too or approved projects sit un-invoiced.
      if (!order.orderNumber) set.orderNumber = await nextNumber('invoice');
    }
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

    // Record the client's chosen payment method (informational; never alters the
    // stored total). Only written when they actually picked one.
    if (paymentMethod) set.paymentMethod = paymentMethod;

    // Record that the "approval is final" notice was presented + accepted at
    // sign-off (the confirmation page always shows it before this action).
    if (termsVersion) { set.approvalTermsVersion = termsVersion; set.approvalTermsAcceptedAt = now; }

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
    // Human label for the chosen payment method + its fee, for the owner's email.
    const payLabel = paymentMethod === 'cc' ? 'Credit card (+2.99% fee)'
      : paymentMethod === 'ach' ? 'ACH bank transfer (+1% fee)'
      : '';
    notifyAdminAndLog(
      order._id,
      `[Joint Printing] Approved — ${order.companyName || order.clientName || 'Project'} (#${order.projectNumber || ''})`,
      `<p><strong>${_esc(_actorLine(by, email, order))}</strong> approved project #${order.projectNumber || ''}.</p>` +
      (order.companyName ? `<p style="color:#555">${_esc(order.companyName)}</p>` : '') +
      `<p>Total: $${approvedTotal.toFixed(2)}</p>` +
      (payLabel ? `<p>Paying by: ${_esc(payLabel)}</p>` : '') +
      (recips.length ? `<p style="color:#888;font-size:12px">Approval link was shared with: ${recips.map(_esc).join(', ')}</p>` : '') +
      `<p>Open it in the Order Tracker to keep things moving.</p>`,
      'Client approved, but the email notification to you failed to send. Check your email settings.',
    );

    res.json({ ok: true });
  } catch (e) {
    console.error('[approval] public handler failed:', e.message);
    res.status(500).json({ message: 'Something went wrong on our end — please try again.' });
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
    const email = String((req.body && req.body.email) || '').trim().slice(0, 200) || _recipientEmail(req);
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
    console.error('[approval] public handler failed:', e.message);
    res.status(500).json({ message: 'Something went wrong on our end — please try again.' });
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

    // Share guard (H3 + C2): once a confirmation has been built, never let a
    // broken one reach the client — a $0 / no-priced-items confirmation, or one
    // with an over-allocated item. (A pre-confirmation share — the bare quote
    // picker — has no confirmation content and is unaffected.) The builder UI
    // mirrors this so the owner sees it before clicking; the server is the
    // backstop in case a stale tab or direct call slips past.
    const shareIssues = Order.confirmationShareIssues(order.confirmation);
    if (shareIssues.length > 0) {
      return res.status(422).json({ message: shareIssues[0], reason: 'unshareable', issues: shareIssues });
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
    // RE-SHARE AFTER A CHANGE REQUEST: if the owner re-shares the SAME link (no
    // rotation) while the current decision is "requested_changes", reopen the cycle
    // on that same token — the client's existing URL flips from the "we're on it"
    // dead-end back to a live Approve / Request-edits ask, and the guest list +
    // emailed link survive (unlike "Start a fresh link"). Reuses the supersededAt
    // cutoff the rotate path uses. NEVER fires for 'approved' (money booked +
    // tracking started) — the status guard enforces that.
    if (!rotated && _currentApprovalStatus(order).status === 'requested_changes') {
      order.approvalSupersededAt = new Date(now);
      order.optionsPickedAt = null;   // mirror the rotate path's stale-pick clear
      order.activity = order.activity || [];
      order.activity.push({
        kind: 'approval_reopened', actor: 'admin',
        message: 'Reopened for approval after revisions',
        meta: { reopened: true }, at: new Date(now),
      });
    }
    if (rotated) {
      order.approvalToken = crypto.randomBytes(16).toString('hex');
      // Fresh token = fresh approval cycle. Prior approved/requested_changes
      // events become historical (see _currentApprovalStatus), and the guest
      // list resets since the old links no longer work.
      order.approvalSupersededAt = new Date(now);
      // C1: clear the previous cycle's pick gate so a returning client isn't
      // stranded on the old "building your confirmation" interstitial. The new
      // cycle starts at the current confirmation (or a fresh picker), not a
      // stale post-pick state.
      order.optionsPickedAt = null;
      order.approvalRecipients = [];
    }
    order.approvalTokenExpiresAt = new Date(now + ttlDays * 24 * 60 * 60 * 1000);

    // Each recipient gets the same hub token but a personal `r` tag (their
    // email, base64url) — so views/picks/approvals attribute to the right
    // person automatically and the page never has to ask who they are.
    const urlFor = (to) =>
      `${frontendOrigin}/approve/${order._id}?token=${order.approvalToken}&r=${Buffer.from(String(to)).toString('base64url')}`;
    const expiry = order.approvalTokenExpiresAt.toLocaleString();
    const projectLabel = order.companyName || order.clientName || `Project #${order.projectNumber || ''}`;
    const safeLabel = String(projectLabel).replace(/</g, '&lt;');
    // Greet by first name only when there's a single, presumably-the-client
    // recipient — otherwise a neutral, still-friendly "Hi there,".
    const greeting = (emails.length === 1 && order.clientName)
      ? `Hi ${String(order.clientName).split(/\s+/)[0]},`
      : 'Hi there,';
    const htmlFor = (url) => `
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
        await sendEmail({ to, subject: `Your proof for ${projectLabel} is ready to look over`, html: htmlFor(urlFor(to)) });
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
      // The shareable hub link (no personal r tag) — what the dialog shows for
      // copy/preview. Per-recipient tagged links were already sent above.
      url: `${frontendOrigin}/approve/${order._id}?token=${order.approvalToken}`,
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

// POST /api/orders/:id/confirmation/publish — the owner's "Push to client"
// action. Flips the confirmation from a private draft to LIVE on the client's
// EXISTING link by setting confirmation.publishedAt. Until this runs, building
// and saving the confirmation stays invisible to the client (they sit on the
// "we're finalizing your order" buffer) so the owner can double-check the
// numbers first. Never touches the approval token — same link, nothing new
// minted. If the client had requested changes, re-publishing reopens the cycle
// on the same link so the revised confirmation is a fresh approve/request ask.
const publishConfirmation = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Project not found' });

    // Nothing to push until a real confirmation exists.
    if (!Order.hasConfirmationContent(order.confirmation)) {
      return res.status(400).json({ message: 'Build the confirmation first — there is nothing to push yet.', reason: 'empty' });
    }
    // Same backstop as sharing: never push a $0 / no-priced-items / over-allocated
    // confirmation to the client. The builder mirrors this before the button.
    const shareIssues = Order.confirmationShareIssues(order.confirmation);
    if (shareIssues.length > 0) {
      return res.status(422).json({ message: shareIssues[0], reason: 'unshareable', issues: shareIssues });
    }
    // Already approved = money booked + tracking started. A revision there must
    // go through "Start a fresh link", not a silent re-push.
    if (_currentApprovalStatus(order).status === 'approved') {
      return res.status(409).json({ message: 'The client already approved this order.', reason: 'already_approved' });
    }

    const now = new Date();
    if (!order.confirmation) order.confirmation = {};
    order.confirmation.publishedAt = now;
    order.markModified('confirmation');

    // If the client had asked for changes, this push IS the revised ask: reopen
    // the cycle on the SAME token (mirrors sendApprovalLink's reopen path) so
    // their existing link flips from the "we're on it" dead-end back to a live
    // Approve / Request-edits screen.
    const reopened = _currentApprovalStatus(order).status === 'requested_changes';
    if (reopened) order.approvalSupersededAt = new Date(now);

    order.activity = order.activity || [];
    order.activity.push({
      kind: 'confirmation_pushed', actor: 'admin',
      message: reopened ? 'Pushed revised confirmation to the client' : 'Pushed confirmation to the client',
      meta: { published: true, reopened }, at: now,
    });
    await order.save();

    res.json({
      ok: true,
      publishedAt: now,
      reopened,
      // The frontend uses this to offer a one-tap "email them it's ready" via the
      // existing send flow when the client hasn't been emailed the link yet.
      hasRecipients: (order.approvalRecipients || []).length > 0,
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
  publicOrderDoc,
  notifyAdmin,  // reused by lookbooks (same best-effort heads-up email)
  publicGetProject, publicApprove, publicRequestChanges, publicSelectOptions,
  publishConfirmation,
  updateTracking, initTracking,
  DEFAULT_TRACKING_STEPS,
  // Exported for unit tests (pure helpers).
  _pickedAtForCycle, _currentApprovalStatus,
  _esc,  // notification-email escaping, reused by lookbooks
  expireLegacyApprovalTokens,
  backfillConfirmationPublished,
};
