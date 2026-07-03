// services/signals.js
//
// Smart Alerts — one server-composed, severity-ranked "what needs your attention"
// feed for the Studio hub. This does NOT invent business logic: it COMPOSES the
// roll-up rules the ecosystem already trusts —
//   • order turnaround aging       (controllers/orders.js orderPlacedAt/etAgeDays)
//   • approved / quoted stalling    (pre-placement + pre-sale funnel gaps)
//   • money owed: cost-without-pay + delivered-but-unpaid orders
//   • CRM follow-ups due/overdue    (utils/time dayDiffFromToday, crm rules)
//   • big deals gone quiet / no next step  (crm.js classifyHeadsUp, $5k+)
//   • buyer replies to answer       (services/replyTriage worklistFromReplies)
//   • vendor POs past their in-hands date  (PurchaseOrder.dueDate × Order status)
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
const PurchaseOrder = require('../models/PurchaseOrder');

const { orderPlacedAt, etAgeDays } = require('../controllers/orders');
const { paymentGapsForOrders, orderInProgress, normalizeOrderNumber } = require('../controllers/finances');
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
// An order the client approved (invoice sent) that hasn't moved to 'placed' in
// this many ET days = money to chase / blanks to order. The /attention age feed
// deliberately excludes 'approved', so this is an otherwise-uncovered gap.
const APPROVED_STALLED_DAYS = 5;
// A quote (pre-sale) sitting unapproved this many ET days = nudge or write off.
const QUOTE_STALE_DAYS = 14;
// A top-tier deal at/above this value is a "big deal" for the hub's loudest CRM
// signals (gone-quiet / no-next-step). Higher than BIG_DEAL so only the deals
// worth interrupting the owner for surface — the owner's call: $5k+.
const HOT_QUIET_MIN = 5000;
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

// The instant an order was approved: the status_changed→approved activity event
// (mirrors orders.js orderPlacedAt), then the approval acceptance timestamp.
// Returns null when the approval time is unknown so we never flag on a stale
// createdAt (avoids false "stalled" positives for an order approved long ago).
function orderApprovedAt(o) {
  const ev = (Array.isArray(o.activity) ? o.activity : [])
    .filter((e) => e && e.kind === 'status_changed' && e.meta && e.meta.to === 'approved')
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0))[0];
  return (ev && ev.at) || o.approvalTermsAcceptedAt || null;
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

async function approvedStalled(now) {
  const rows = await Order.find({ status: 'approved', archived: { $ne: true } })
    .select('projectNumber orderNumber companyName clientName status orderDate createdAt activity approvalTermsAcceptedAt')
    .lean();
  const items = [];
  for (const o of rows) {
    const ageDays = etAgeDays(orderApprovedAt(o), now);
    if (ageDays == null || ageDays < APPROVED_STALLED_DAYS) continue;
    items.push({
      _id: String(o._id),
      projectNumber: o.projectNumber || '',
      orderNumber: o.orderNumber || '',
      name: nameOf(o) || (o.projectNumber ? `#${o.projectNumber}` : 'Order'),
      metric: `${ageDays}d`,
    });
  }
  items.sort((a, b) => parseInt(b.metric, 10) - parseInt(a.metric, 10));
  return [
    { id: 'approved_stalled', severity: 'warning', kind: 'order',
      label: `${items.length} approved order${items.length === 1 ? '' : 's'} awaiting placement · ${APPROVED_STALLED_DAYS}+ days`,
      count: items.length, items: cap(items) },
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

async function bigDealsAttention(now) {
  // The hub's loudest CRM signals, from ONE lean query over big open deals ($5k+):
  //   • hot_quiet    — a big deal we've gone quiet on (no contact 2+ weeks, or never);
  //                    the flag the heads-up engine calls the owner's biggest blind spot.
  //   • no_next_step — a big deal with nothing scheduled (fall-through risk).
  // Both come straight from the CRM heads-up engine (classifyHeadsUp) so the rule
  // matches the CRM dashboard exactly. A gone-quiet deal is deduped OUT of the
  // no-next-step group so a neglected deal shows once, as the louder critical.
  const clients = await Client.find({
    archived: { $ne: true },
    stage: { $nin: FOLLOWUP_CLOSED_STAGES },
    dealValue: { $gte: HOT_QUIET_MIN },
  }).select('companyKey companyName clientName phone contacts dealValue stage nextFollowUp lastContact tags updatedAt').lean();
  const nowMs = now.getTime();
  const todayMs = etStartOfToday(now).getTime();
  const quiet = [];
  const noStep = [];
  for (const c of clients) {
    for (const it of classifyHeadsUp(c, nowMs, todayMs)) {
      if (it.type === 'hot_quiet') quiet.push(it);
      else if (it.type === 'no_next_step') noStep.push(it);
    }
  }
  const quietKeys = new Set(quiet.map((it) => it.companyKey));
  const noStepClean = noStep.filter((it) => !quietKeys.has(it.companyKey));
  const byValue = (a, b) => (Number(b.value) || 0) - (Number(a.value) || 0);
  const toItem = (it) => ({
    companyKey: it.companyKey || '',
    name: it.name || 'Company',
    metric: `$${Math.round(Number(it.value) || 0).toLocaleString('en-US')}`,
  });
  quiet.sort(byValue);
  noStepClean.sort(byValue);
  return [
    { id: 'big_deal_quiet', severity: 'critical', kind: 'crm',
      label: `${quiet.length} big deal${quiet.length === 1 ? '' : 's'} gone quiet · $5k+`,
      count: quiet.length, items: cap(quiet.map(toItem)) },
    { id: 'big_deal_no_next_step', severity: 'warning', kind: 'crm',
      label: `${noStepClean.length} big deal${noStepClean.length === 1 ? '' : 's'} with no next step`,
      count: noStepClean.length, items: cap(noStepClean.map(toItem)) },
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

async function deliveredUnpaid() {
  // A delivered order still marked unpaid — the job is done and the money hasn't
  // been collected. Distinct from cost_without_payment (a ledger gap): this is the
  // order flag itself. Rows are value-sorted then deduped by canonical order # so a
  // duplicate order doc never counts the same invoice twice.
  const rows = await Order.find({
    status: 'delivered', paid: { $ne: true }, archived: { $ne: true }, orderNumber: { $ne: '' },
  }).select('projectNumber orderNumber companyName clientName totalValue').lean();
  rows.sort((a, b) => (Number(b.totalValue) || 0) - (Number(a.totalValue) || 0));
  const seen = new Set();
  const items = [];
  for (const o of rows) {
    const key = normalizeOrderNumber(o.orderNumber) || String(o._id);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      projectNumber: o.projectNumber || '',
      orderNumber: o.orderNumber || '',
      name: nameOf(o) || (o.projectNumber ? `#${o.projectNumber}` : 'Order'),
      metric: `$${Math.round(Number(o.totalValue) || 0).toLocaleString('en-US')}`,
    });
  }
  return [
    { id: 'delivered_unpaid', severity: 'critical', kind: 'order',
      label: `${items.length} delivered order${items.length === 1 ? '' : 's'} unpaid`,
      count: items.length, items: cap(items) },
  ];
}

async function quoteStale(now) {
  // A quote (pre-sale) the client hasn't approved, aged past QUOTE_STALE_DAYS —
  // time to nudge them or write it off. Anchored to orderDate, else createdAt.
  const rows = await Order.find({ status: 'quoted', archived: { $ne: true } })
    .select('projectNumber orderNumber companyName clientName orderDate createdAt').lean();
  const items = [];
  for (const o of rows) {
    const ageDays = etAgeDays(o.orderDate || o.createdAt, now);
    if (ageDays == null || ageDays < QUOTE_STALE_DAYS) continue;
    items.push({
      projectNumber: o.projectNumber || '',
      orderNumber: o.orderNumber || '',
      name: nameOf(o) || (o.projectNumber ? `#${o.projectNumber}` : 'Quote'),
      metric: `${ageDays}d`,
    });
  }
  items.sort((a, b) => parseInt(b.metric, 10) - parseInt(a.metric, 10));
  return [
    { id: 'quote_stale', severity: 'warning', kind: 'order',
      label: `${items.length} quote${items.length === 1 ? '' : 's'} awaiting approval · ${QUOTE_STALE_DAYS}+ days`,
      count: items.length, items: cap(items) },
  ];
}

async function vendorPoLate(now) {
  // A purchase order past its in-hands (due) date whose linked order isn't done —
  // the printer promised a date and the job still isn't delivered. There's no PO
  // fulfillment field, so "done" is inferred from the linked order's status.
  const pos = await PurchaseOrder.find({
    archived: { $ne: true }, orderId: { $ne: null }, dueDate: { $ne: null },
  }).select('poNumber vendorName dueDate orderId').lean();
  const overdue = pos.filter((p) => { const d = dayDiffFromToday(p.dueDate, now); return d != null && d < 0; });
  const byId = {};
  if (overdue.length) {
    const orders = await Order.find({ _id: { $in: overdue.map((p) => p.orderId) } })
      .select('orderNumber projectNumber companyName clientName status').lean();
    for (const o of orders) byId[String(o._id)] = o;
  }
  const items = [];
  for (const p of overdue) {
    const o = byId[String(p.orderId)];
    if (!o || o.status === 'delivered' || o.status === 'cancelled') continue;
    const lateDays = -dayDiffFromToday(p.dueDate, now);
    items.push({
      projectNumber: o.projectNumber || '',
      orderNumber: o.orderNumber || '',
      name: p.vendorName ? `${p.vendorName}${p.poNumber ? ` · ${p.poNumber}` : ''}` : 'Vendor PO',
      metric: `${lateDays}d late`,
    });
  }
  items.sort((a, b) => parseInt(b.metric, 10) - parseInt(a.metric, 10));
  return [
    { id: 'vendor_po_late', severity: 'warning', kind: 'order',
      label: `${items.length} vendor PO${items.length === 1 ? '' : 's'} past the in-hands date`,
      count: items.length, items: cap(items) },
  ];
}

// buildSignals — compose all sources; a thrown source drops only its group.
async function buildSignals({ now = new Date() } = {}) {
  const sources = [
    ordersAging(now), deliveredUnpaid(), moneyOwed(), followUps(now), bigDealsAttention(now),
    repliesWaiting(), approvedStalled(now), quoteStale(now), vendorPoLate(now),
  ];
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
  orderApprovedAt,
  bucketFollowUps,
  replySeverity,
  toGroups,
  // constants (mirrored to the frontend)
  AGE_RUNNING_LONG,
  AGE_POSSIBLY_LATE,
  BIG_DEAL,
  ITEM_CAP,
};
