// services/signals.js
//
// Smart Alerts — one server-composed, severity-ranked "what needs your attention"
// feed for the Studio hub. This does NOT invent business logic: it COMPOSES the
// roll-up rules the ecosystem already trusts —
//   • order turnaround aging      (controllers/orders.js orderPlacedAt/etAgeDays)
//   • money sunk with no payment   (controllers/finances.js paymentGapsForOrders)
//   • CRM follow-ups due/overdue   (utils/time dayDiffFromToday, crm rules)
//   • buyer replies to answer      (services/replyTriage worklistFromReplies)
// — into a single { groups:{critical,warning,info}, counts } payload where every
// item carries the shared identifiers (companyKey / orderNumber / projectNumber)
// the hub's onNavigate/onPick deep-links already use.
//
// Design invariants (mirror the hub's SignalsPanel discipline):
//   • Each source is fetched in its OWN try/catch, so one failing collection drops
//     only its group — never the whole feed (matches the frontend's silent-per-
//     fetch resilience it's replacing).
//   • Empty groups collapse to nothing → a clean day yields no signals at all.
//   • Reads are .lean() and item lists are capped; the count stays the true total.
//
// The backup nudge stays a separate concern (its snooze/HDD gating is pure client
// localStorage state in SignalsPanel), so it is intentionally NOT folded in here.

const Order = require('../models/Order');
const Client = require('../models/Client');
const Transaction = require('../models/Transaction');
const TriageReply = require('../models/TriageReply');

const { orderPlacedAt, etAgeDays } = require('../controllers/orders');
const { paymentGapsForOrders, orderInProgress } = require('../controllers/finances');
const { classifyHeadsUp } = require('../controllers/crm');
const { worklistFromReplies, HOT_CATEGORIES } = require('./replyTriage');
const { dayDiffFromToday, etStartOfToday } = require('../utils/time');

// ── Thresholds (mirrored, keep in sync) ──────────────────────────────────────
// Order turnaround: mirrors controllers/orders.js attention() (owner's explicit
// "warn at 2 weeks / 3 weeks" — ECOSYSTEM.md). Kept as named constants here and
// mirrored in the frontend _shared.js copy.
const AGE_RUNNING_LONG = 14;   // >= 2 weeks since placed
const AGE_POSSIBLY_LATE = 21;  // >= 3 weeks since placed
// Open order statuses that age (mirror ATTENTION_OPEN_STATUSES in orders.js:513).
const ATTENTION_OPEN_STATUSES = ['placed', 'in_production', 'shipped'];
// CRM stages excluded from follow-up alerts (mirror crm.js getToday CLOSED_STAGES).
const FOLLOWUP_CLOSED_STAGES = ['won', 'lost', 'dormant'];
// A neglected deal at/above this value escalates (mirror crm.js HEADS_UP).
const BIG_DEAL = 2000;
// Cap the per-group item list; the group count still reflects the true total.
const ITEM_CAP = 25;

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// The turnaround flag for an order age in whole ET days.
function classifyOrderAge(ageDays) {
  if (ageDays == null) return null;
  if (ageDays >= AGE_POSSIBLY_LATE) return 'possibly_late';
  if (ageDays >= AGE_RUNNING_LONG) return 'running_long';
  return null;
}

// Split active follow-ups into overdue (before today) vs dueToday, by ET calendar
// day. `clients` are lean docs with { nextFollowUp, stage }. Closed stages excluded.
function bucketFollowUps(clients = [], now = new Date()) {
  const overdue = [];
  const dueToday = [];
  for (const c of clients) {
    if (!c || c.nextFollowUp == null) continue;
    if (FOLLOWUP_CLOSED_STAGES.includes(c.stage)) continue;
    const diff = dayDiffFromToday(c.nextFollowUp, now);
    if (diff == null) continue;
    if (diff < 0) overdue.push(c);
    else if (diff === 0) dueToday.push(c);
  }
  // Most-overdue first for the overdue bucket.
  overdue.sort((a, b) => dayDiffFromToday(a.nextFollowUp, now) - dayDiffFromToday(b.nextFollowUp, now));
  return { overdue, dueToday };
}

// A live inbound reply is a warning, but escalates to critical when any waiting
// reply is a hot buying signal (hot_lead / asked_pricing / asked_mockups).
function replySeverity(needsResponse = []) {
  return needsResponse.some((r) => r && HOT_CATEGORIES.has(r.category)) ? 'critical' : 'warning';
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

async function moneyOwed() {
  const all = await Order.find({ orderNumber: { $ne: '' } })
    .select('orderNumber companyName clientName totalValue paid status').lean();
  const orders = all.filter(orderInProgress);
  const txns = await Transaction.find({ orderNumber: { $ne: '' } })
    .select('type category amount isCredit orderNumber date').lean();
  const gaps = paymentGapsForOrders(orders, txns);
  const rows = (gaps.orders || []).filter((r) => r.costWithoutPayment);
  const items = rows.map((r) => ({
    orderNumber: r.orderNumber || '',
    name: r.client && r.client !== '—' ? r.client : `#${r.orderNumber}`,
    metric: `$${Math.round(Number(r.cost) || 0).toLocaleString('en-US')}`,
  }));
  return [
    { id: 'cost_without_payment', severity: 'critical', kind: 'order',
      label: `${items.length} job${items.length === 1 ? '' : 's'} produced with no client payment recorded`,
      count: items.length, items: cap(items) },
  ];
}

async function followUps(now) {
  const clients = await Client.find({
    archived: { $ne: true },
    nextFollowUp: { $ne: null },
    stage: { $nin: FOLLOWUP_CLOSED_STAGES },
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

async function bigDealsQuiet(now) {
  // "Hot deal gone quiet" — a top-tier open deal (dealValue >= $2k) we've neglected
  // (no contact in 2+ weeks, or never). Reuses the CRM heads-up engine's exact
  // rule (classifyHeadsUp → 'hot_quiet') — the flag the engine itself calls the
  // owner's biggest blind spot. Pre-filtered to big open deals so the scan is cheap.
  const clients = await Client.find({
    archived: { $ne: true },
    stage: { $nin: FOLLOWUP_CLOSED_STAGES },
    dealValue: { $gte: BIG_DEAL },
  }).select('companyKey companyName clientName phone contacts dealValue stage nextFollowUp lastContact tags updatedAt').lean();
  const nowMs = now.getTime();
  const todayMs = etStartOfToday(now).getTime();
  const hot = [];
  for (const c of clients) {
    for (const it of classifyHeadsUp(c, nowMs, todayMs)) {
      if (it.type === 'hot_quiet') hot.push(it);
    }
  }
  hot.sort((a, b) => (Number(b.value) || 0) - (Number(a.value) || 0)); // biggest deal first
  const items = hot.map((it) => ({
    companyKey: it.companyKey || '',
    name: it.name || 'Company',
    metric: `$${Math.round(Number(it.value) || 0).toLocaleString('en-US')}`,
  }));
  return [
    { id: 'big_deal_quiet', severity: 'critical', kind: 'crm',
      label: `${items.length} hot deal${items.length === 1 ? '' : 's'} gone quiet`,
      count: items.length, items: cap(items) },
  ];
}

async function repliesWaiting() {
  const open = await TriageReply.find({
    status: { $in: ['new', 'quote_requested', 'mockup_requested', 'follow_up'] },
  }).select('category status receivedAt companyKey companyName fromName fromEmail').lean();
  const wl = worklistFromReplies(open);
  const needs = wl.needsResponse || [];
  const items = needs.map((r) => ({
    companyKey: r.companyKey || '',
    name: (r.companyName || r.fromName || r.fromEmail || 'Reply'),
    metric: HOT_CATEGORIES.has(r.category) ? 'hot' : '',
  }));
  return [
    { id: 'reply_awaiting_triage', severity: replySeverity(needs), kind: 'triage',
      label: `${items.length} buyer repl${items.length === 1 ? 'y' : 'ies'} awaiting a response`,
      count: items.length, items: cap(items) },
  ];
}

// buildSignals — compose all sources; a thrown source drops only its group.
async function buildSignals({ now = new Date() } = {}) {
  const sources = [ordersAging(now), moneyOwed(), followUps(now), repliesWaiting(), bigDealsQuiet(now)];
  const settled = await Promise.allSettled(sources);
  const all = [];
  for (const r of settled) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) all.push(...r.value);
    // a rejected source is silently dropped (its group simply doesn't appear)
  }
  const { groups, counts } = toGroups(all);
  return { generatedAt: now.toISOString(), counts, groups };
}

module.exports = {
  buildSignals,
  // pure helpers exported for tests
  classifyOrderAge,
  bucketFollowUps,
  replySeverity,
  toGroups,
  // constants (mirrored to the frontend)
  AGE_RUNNING_LONG,
  AGE_POSSIBLY_LATE,
  BIG_DEAL,
  ITEM_CAP,
};
