// services/signals.js
//
// Signals — the Studio hub's compact "what needs your attention" feed. One
// server-composed, severity-ranked payload from the roll-ups the hub has always
// shown: open orders aging past the owner's turnaround, and CRM follow-ups
// due/overdue. (New-site-inquiry and the backup nudge are surfaced client-side in
// SignalsPanel, from data the hub already has.)
//
// Design invariants (mirror the hub's SignalsPanel discipline):
//   • Each source is fetched in its OWN try/catch, so one failing collection drops
//     only its group — never the whole feed.
//   • Empty groups collapse to nothing → a clean day yields no signals at all.
//   • Reads are .lean() and item lists are capped; the count stays the true total.

const Order = require('../models/Order');
const Client = require('../models/Client');
const TriageReply = require('../models/TriageReply');

const { orderPlacedAt, etAgeDays } = require('../controllers/orders');
const { HOT_CATEGORIES, ACTIONABLE_CATEGORIES } = require('./replyTriage');
const { dayDiffFromToday } = require('../utils/time');

// ── Thresholds ───────────────────────────────────────────────────────────────
// Order turnaround: mirrors controllers/orders.js attention() (owner's explicit
// "warn at 2 weeks / 3 weeks" — ECOSYSTEM.md).
const AGE_RUNNING_LONG = 14;   // >= 2 weeks since placed
const AGE_POSSIBLY_LATE = 21;  // >= 3 weeks since placed
// Open order statuses that age (mirror ATTENTION_OPEN_STATUSES in orders.js).
const ATTENTION_OPEN_STATUSES = ['placed', 'in_production', 'shipped'];
// Follow-up alerts are NOT stage-gated — a scheduled follow-up (incl. a won
// client's post-delivery QA touch) is deliberate work and always surfaces, matching
// the CRM Today list. (nextFollowUp is never auto-set on a closed card.)
// A follow-up on a deal at/above this value shows its dollar amount.
const BIG_DEAL = 2000;
// Quote validity — MIRROR of controllers/approval.js QUOTE_VALID_DAYS (keep in sync):
// a pushed quote is good for this many days. Surface it on the hub once it's within
// QUOTE_EXPIRY_WARN_DAYS of lapsing (or already lapsed) and still unapproved — an
// unanswered quote is money on the table to chase before the window closes.
const QUOTE_VALID_DAYS = 7;
const QUOTE_EXPIRY_WARN_DAYS = 2;
// Cap the per-group item list; the group count still reflects the true total.
const ITEM_CAP = 25;
// An un-actioned (status:'new') inquiry older than this many days escalates its
// brand's group to critical — a live inbound lead has been waiting too long.
const INQUIRY_STALE_DAYS = 2;
// ContactSubmission.source → the brand label + the Studio inbox view that opens
// (and marks seen) ONLY that brand's pipe. Order = display order.
const INQUIRY_BRANDS = [
  { source: 'contact',  brand: 'Joint Printing', view: 'submissions' },
  { source: 'webworks', brand: 'JP Webworks',    view: 'jpwinquiries' },
  { source: 'atom',     brand: 'JP Atom',        view: 'atominquiries' },
];

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// The turnaround flag for an order age in whole ET days.
function classifyOrderAge(ageDays) {
  if (ageDays == null) return null;
  if (ageDays >= AGE_POSSIBLY_LATE) return 'possibly_late';
  if (ageDays >= AGE_RUNNING_LONG) return 'running_long';
  return null;
}

// Split scheduled follow-ups into overdue (before today) vs dueToday, by ET
// calendar day. `clients` are lean docs with { nextFollowUp }. NOT stage-gated: a
// follow-up date is only ever set deliberately (never auto-set on a closed card),
// so a won client's post-delivery QA touch counts here exactly as it shows on the
// CRM Today list — a scheduled follow-up is never hidden by stage.
function bucketFollowUps(clients = [], now = new Date()) {
  const overdue = [];
  const dueToday = [];
  for (const c of clients) {
    if (!c || c.nextFollowUp == null) continue;
    const diff = dayDiffFromToday(c.nextFollowUp, now);
    if (diff == null) continue;
    if (diff < 0) overdue.push(c);
    else if (diff === 0) dueToday.push(c);
  }
  // Most-overdue first for the overdue bucket.
  overdue.sort((a, b) => dayDiffFromToday(a.nextFollowUp, now) - dayDiffFromToday(b.nextFollowUp, now));
  return { overdue, dueToday };
}

// A short "3h" / "2d" age label for an inbound reply. '' when unknown/future.
function replyAgeLabel(receivedAt, now = new Date()) {
  const h = (now.getTime() - new Date(receivedAt).getTime()) / 3600000;
  if (!Number.isFinite(h) || h < 0) return '';
  return h >= 24 ? `${Math.round(h / 24)}d` : `${Math.max(1, Math.round(h))}h`;
}

// Split NEW, still-un-answered outreach replies into hot (a real buying signal —
// asked pricing / a mockup / high intent) vs. other actionable replies. PURE:
// the source passes rows already sorted oldest-first, so order = urgency.
function bucketOutreachReplies(replies = [], now = new Date()) {
  const hot = [];
  const other = [];
  for (const r of replies) {
    if (!r || r.status !== 'new' || !ACTIONABLE_CATEGORIES.has(r.category)) continue;
    const item = {
      companyKey: r.companyKey || '',
      name: (r.companyName || r.fromName || r.fromEmail || 'Lead'),
      metric: replyAgeLabel(r.receivedAt, now),
    };
    (HOT_CATEGORIES.has(r.category) ? hot : other).push(item);
  }
  return { hot, other };
}

// Bucket un-actioned inquiries (status:'new', bots excluded upstream) into one
// per-brand group. PURE — takes lean submissions, returns the group list. The
// severity is per BRAND: warning while every waiting lead is fresh, critical as
// soon as its oldest has waited INQUIRY_STALE_DAYS+. "Unspoken-to" is status
// 'new' (not seenByAdmin): opening the inbox clears the badge/banner, but the
// signal keeps nudging until the owner actually acts (→ contacted/spam/…).
function bucketInquiries(subs = [], now = new Date()) {
  const bySource = new Map(INQUIRY_BRANDS.map((b) => [b.source, []]));
  for (const s of subs) {
    if (!s || s.status !== 'new') continue;
    const key = bySource.has(s.source) ? s.source : 'contact';
    bySource.get(key).push(s);
  }
  return INQUIRY_BRANDS.map(({ source, brand, view }) => {
    const rows = bySource.get(source) || [];
    rows.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // oldest first
    const oldest = rows[0];
    const oldestDays = oldest ? (now.getTime() - new Date(oldest.createdAt).getTime()) / 86400000 : 0;
    const items = rows.map((r) => ({
      _id: String(r._id || ''),
      name: (r.companyName || r.name || 'Lead'),
      metric: replyAgeLabel(r.createdAt, now),
    }));
    return {
      id: `inquiry_${source}`,
      severity: oldestDays >= INQUIRY_STALE_DAYS ? 'critical' : 'warning',
      kind: 'inquiry', brand, view,
      label: `${rows.length} ${brand} inquir${rows.length === 1 ? 'y' : 'ies'} awaiting a reply`,
      count: rows.length, items: cap(items),
    };
  });
}

// Bucket a flat list of signal groups into { critical, warning, info } in the
// order they were produced, dropping any empty group. Returns groups + counts.
function toGroups(signalGroups = []) {
  const groups = { critical: [], warning: [], info: [] };
  for (const g of signalGroups) {
    if (!g || !g.count || !groups[g.severity]) continue;
    groups[g.severity].push(g);
  }
  const counts = {
    critical: groups.critical.length,
    warning: groups.warning.length,
    info: groups.info.length,
  };
  counts.total = counts.critical + counts.warning + counts.info;
  return { groups, counts };
}

const cap = (arr) => arr.slice(0, ITEM_CAP);
const nameOf = (o) => (o && (o.companyName || o.clientName)) ? String(o.companyName || o.clientName).trim() : '';

// A pushed quote's remaining validity in whole days (ceil) from quotePushedAt +
// QUOTE_VALID_DAYS. <= 0 means already lapsed. null when never pushed. Pure.
function quoteDaysLeft(quotePushedAt, now = new Date()) {
  if (!quotePushedAt) return null;
  const expiresAt = new Date(quotePushedAt).getTime() + QUOTE_VALID_DAYS * 86400000;
  if (Number.isNaN(expiresAt)) return null;
  return Math.ceil((expiresAt - now.getTime()) / 86400000);
}

// Quotes OUT to the client and still unapproved (the caller passes only status:
// 'quoted' orders with a quotePushedAt) that are within QUOTE_EXPIRY_WARN_DAYS of
// lapsing — or already lapsed — the "nudge before it dies" list, most-lapsed/soonest
// first. A quote with real runway left is NOT surfaced (no noise). Pure.
function bucketQuotesAwaiting(orders = [], now = new Date()) {
  const out = [];
  for (const o of orders) {
    if (!o || !o.quotePushedAt) continue;
    const daysLeft = quoteDaysLeft(o.quotePushedAt, now);
    if (daysLeft == null || daysLeft > QUOTE_EXPIRY_WARN_DAYS) continue; // still has runway
    out.push({
      _id: String(o._id || ''),
      projectNumber: o.projectNumber || '',
      orderNumber: o.orderNumber || '',
      name: nameOf(o) || (o.projectNumber ? `#${o.projectNumber}` : 'Quote'),
      metric: daysLeft < 0 ? `${-daysLeft}d ago` : daysLeft === 0 ? 'today' : `${daysLeft}d left`,
      daysLeft,
    });
  }
  out.sort((a, b) => a.daysLeft - b.daysLeft); // most-lapsed / soonest-to-lapse first
  return out;
}

// ── Composition (hits the DB; each source isolated) ──────────────────────────

async function ordersAging(now) {
  const open = await Order.find({ status: { $in: ATTENTION_OPEN_STATUSES }, archived: { $ne: true } })
    .select('projectNumber orderNumber companyName clientName status orderDate createdAt activity')
    .lean();
  const late = [];
  const long = [];
  for (const o of open) {
    const ageDays = etAgeDays(orderPlacedAt(o), now);
    const flag = classifyOrderAge(ageDays);
    if (!flag) continue;
    const item = {
      _id: String(o._id),
      projectNumber: o.projectNumber || '',
      orderNumber: o.orderNumber || '',
      name: nameOf(o) || (o.projectNumber ? `#${o.projectNumber}` : 'Order'),
      metric: `${ageDays}d`,
    };
    (flag === 'possibly_late' ? late : long).push(item);
  }
  late.sort((a, b) => parseInt(b.metric, 10) - parseInt(a.metric, 10));
  long.sort((a, b) => parseInt(b.metric, 10) - parseInt(a.metric, 10));
  return [
    { id: 'order_possibly_late', severity: 'critical', kind: 'order',
      label: `${late.length} order${late.length === 1 ? '' : 's'} possibly late · 3+ weeks`,
      count: late.length, items: cap(late) },
    { id: 'order_running_long', severity: 'warning', kind: 'order',
      label: `${long.length} order${long.length === 1 ? '' : 's'} running long · 2+ weeks`,
      count: long.length, items: cap(long) },
  ];
}

async function followUps(now) {
  const clients = await Client.find({
    archived: { $ne: true },
    nextFollowUp: { $ne: null },
  }).select('companyKey companyName clientName dealValue nextFollowUp stage').lean();
  const { overdue, dueToday } = bucketFollowUps(clients, now);
  const toItem = (c) => ({
    companyKey: c.companyKey || '',
    name: nameOf(c) || 'Company',
    metric: Number(c.dealValue) >= BIG_DEAL ? `$${Math.round(c.dealValue).toLocaleString('en-US')}` : '',
  });
  return [
    { id: 'followup_overdue', severity: 'critical', kind: 'crm',
      label: `${overdue.length} follow-up${overdue.length === 1 ? '' : 's'} overdue`,
      count: overdue.length, items: cap(overdue.map(toItem)) },
    { id: 'followup_due_today', severity: 'info', kind: 'crm',
      label: `${dueToday.length} follow-up${dueToday.length === 1 ? '' : 's'} due today`,
      count: dueToday.length, items: cap(dueToday.map(toItem)) },
  ];
}

// Quotes sent to the client and sitting unapproved as they near/pass their validity
// window — the owner's "chase this before it lapses" nudge. status:'quoted' means
// not-yet-approved (approving flips it to 'approved'); only quotes actually pushed to
// the client are considered. kind:'order' → the hub row deep-links straight to the
// order (reuses the existing order nav). Not in ATTENTION_OPEN_STATUSES, so it never
// double-counts with the order-aging groups.
async function quotesAwaiting(now) {
  const quoted = await Order.find({ status: 'quoted', archived: { $ne: true }, quotePushedAt: { $ne: null } })
    .select('projectNumber orderNumber companyName clientName quotePushedAt status').lean();
  const items = bucketQuotesAwaiting(quoted, now);
  return [
    { id: 'quote_expiring', severity: 'warning', kind: 'order',
      label: `${items.length} quote${items.length === 1 ? '' : 's'} awaiting approval · expiring`,
      count: items.length, items: cap(items) },
  ];
}

// Un-answered outreach replies → the hub alert the owner asked for: a heads-up
// when a good lead has replied and is waiting. Hot (buying-signal) replies are
// critical; other new replies to answer are info. kind:'triage' → the hub row
// deep-links to the Outreach → Replies inbox.
async function outreachReplies(now) {
  const replies = await TriageReply.find({
    status: 'new',
    category: { $in: [...ACTIONABLE_CATEGORIES] },
  }).select('fromEmail fromName companyKey companyName category receivedAt status')
    .sort({ receivedAt: 1 }).limit(200).lean();
  const { hot, other } = bucketOutreachReplies(replies, now);
  return [
    { id: 'outreach_hot_lead', severity: 'critical', kind: 'triage',
      label: `${hot.length} hot lead${hot.length === 1 ? '' : 's'} waiting on a reply`,
      count: hot.length, items: cap(hot) },
    { id: 'outreach_reply', severity: 'info', kind: 'triage',
      label: `${other.length} new repl${other.length === 1 ? 'y' : 'ies'} to answer`,
      count: other.length, items: cap(other) },
  ];
}

// ── Hub pulse — the live numbers the hub tiles carry ─────────────────────────
// One cheap sweep so every core tile shows its heartbeat (open orders, today's
// follow-ups, the outreach drip, this month's money) instead of a static
// description. Signals say "act on this"; the pulse says "here's where things
// stand" — both ride the same GET /api/signals the hub already loads.
async function hubPulse(now = new Date()) {
  const OutreachEnrollment = require('../models/OutreachEnrollment');
  const Transaction = require('../models/Transaction');
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [openOrders, fuClients, outreachActive, repliesWaiting, monthTxns] = await Promise.all([
    Order.countDocuments({ status: { $in: ATTENTION_OPEN_STATUSES }, archived: { $ne: true } }),
    Client.find({ archived: { $ne: true }, nextFollowUp: { $ne: null } })
      .select('nextFollowUp').lean(),
    OutreachEnrollment.countDocuments({ status: 'active' }),
    TriageReply.countDocuments({ status: 'new', category: { $in: [...ACTIONABLE_CATEGORIES] } }),
    Transaction.find({ date: { $gte: monthStart } }).select('type amount isCredit').lean(),
  ]);

  const { overdue, dueToday } = bucketFollowUps(fuClients, now);
  // Month money — same sign rules as the ledger (a credit reverses its type).
  let revenue = 0; let expenses = 0;
  for (const t of monthTxns) {
    const amt = (t.isCredit ? -1 : 1) * (Number(t.amount) || 0);
    if (t.type === 'income') revenue += amt; else expenses += amt;
  }
  return {
    ordersOpen: openOrders,
    followUpsToday: overdue.length + dueToday.length,
    outreachActive,
    repliesWaiting,
    monthRevenue: Math.round(revenue),
    monthProfit: Math.round(revenue - expenses),
  };
}

// Un-actioned inbound inquiries, one severity-ranked group per brand — the
// owner's "banner when there's an inquiry I haven't spoken to" across all three
// businesses. kind:'inquiry' + `view` → the hub row deep-links to that brand's
// own inbox. Bots excluded here; the pure bucketing/severity logic is above.
async function unhandledInquiries(now) {
  const ContactSubmission = require('../models/ContactSubmission');
  const subs = await ContactSubmission.find({ status: 'new', honeypot: { $ne: true } })
    .select('name companyName source status createdAt')
    .sort({ createdAt: 1 }).limit(300).lean();
  return bucketInquiries(subs, now);
}

// Lookbook feedback the owner hasn't acknowledged — a client tapped 👍/👎 or
// left a comment on a shared gallery. One item per lookbook; the count is the
// unseen entries. Cleared by POST /api/lookbooks/:id/feedback/seen.
async function lookbookFeedback() {
  const Lookbook = require('../models/Lookbook');
  const books = await Lookbook.find({ status: 'shared', 'feedback.0': { $exists: true } })
    .select('companyKey companyName title feedback').lean();
  const items = [];
  let total = 0;
  for (const lb of books) {
    const unseen = (lb.feedback || []).filter((f) => !f.seenAt);
    if (!unseen.length) continue;
    total += unseen.length;
    const latest = unseen[unseen.length - 1];
    items.push({
      _id: String(lb._id),
      companyKey: lb.companyKey,
      name: lb.companyName || lb.title || 'Lookbook',
      metric: `${unseen.length}×`,
      note: latest.comment ? `"${latest.comment.slice(0, 80)}"` : (latest.reaction === 'up' ? '👍' : latest.reaction === 'down' ? '👎' : ''),
    });
  }
  return [
    { id: 'lookbook_feedback', severity: 'warning', kind: 'lookbook',
      label: `${total} lookbook reaction${total === 1 ? '' : 's'} to review`,
      count: total, items: cap(items) },
  ];
}

// Open client-site change requests (edits not yet marked done) — the ongoing-care
// work a JP Webworks subscription pays for. One item per site with a backlog; the
// count is the total open edits. PURE (exported for tests).
function bucketSiteEdits(sites = []) {
  const items = [];
  let total = 0;
  for (const s of sites) {
    const open = (s.edits || []).filter((e) => e && e.status !== 'done').length;
    if (!open) continue;
    total += open;
    items.push({
      _id: String(s._id || ''),
      companyKey: s.companyKey || '',
      name: s.name || s.companyName || 'Client site',
      metric: `${open}×`,
    });
  }
  return { total, items: cap(items) };
}

// JP Webworks client-site edits waiting on the owner. severity 'warning', brand
// 'JP Webworks' so it rides the Webworks hub page. kind:'webworks' → the hub row
// opens the Client Manager (SignalsPanel maps it to onPick('webworksops')).
async function siteEditsWaiting() {
  const JpwSite = require('../models/JpwSite');
  const sites = await JpwSite.find({ archived: { $ne: true }, 'edits.status': { $in: ['open', 'in_progress'] } })
    .select('name companyName companyKey edits').lean();
  const { total, items } = bucketSiteEdits(sites);
  return [
    { id: 'webworks_edits', severity: 'warning', kind: 'webworks', brand: 'JP Webworks',
      label: `${total} client site edit${total === 1 ? '' : 's'} to do`,
      count: total, items },
  ];
}

// buildSignals — compose all sources; a thrown source drops only its group.
async function buildSignals({ now = new Date() } = {}) {
  const sources = [unhandledInquiries(now), ordersAging(now), followUps(now), quotesAwaiting(now), siteEditsWaiting(), outreachReplies(now), lookbookFeedback(now)];
  const [settled, pulse] = await Promise.all([
    Promise.allSettled(sources),
    hubPulse(now).catch(() => null), // pulse is garnish — never sinks the feed
  ]);
  const all = [];
  for (const r of settled) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) all.push(...r.value);
    // a rejected source is silently dropped (its group simply doesn't appear)
  }
  const { groups, counts } = toGroups(all);
  return { generatedAt: now.toISOString(), counts, groups, pulse };
}

module.exports = {
  buildSignals,
  // pure helpers exported for tests
  classifyOrderAge,
  bucketFollowUps,
  bucketOutreachReplies,
  bucketInquiries,
  bucketQuotesAwaiting,
  quoteDaysLeft,
  bucketSiteEdits,
  replyAgeLabel,
  toGroups,
  // constants
  AGE_RUNNING_LONG,
  AGE_POSSIBLY_LATE,
  BIG_DEAL,
  ITEM_CAP,
  INQUIRY_STALE_DAYS,
  INQUIRY_BRANDS,
  QUOTE_VALID_DAYS,
  QUOTE_EXPIRY_WARN_DAYS,
};
