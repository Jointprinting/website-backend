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

const { orderPlacedAt, etAgeDays } = require('../controllers/orders');
const { dayDiffFromToday } = require('../utils/time');

// ── Thresholds ───────────────────────────────────────────────────────────────
// Order turnaround: mirrors controllers/orders.js attention() (owner's explicit
// "warn at 2 weeks / 3 weeks" — ECOSYSTEM.md).
const AGE_RUNNING_LONG = 14;   // >= 2 weeks since placed
const AGE_POSSIBLY_LATE = 21;  // >= 3 weeks since placed
// Open order statuses that age (mirror ATTENTION_OPEN_STATUSES in orders.js).
const ATTENTION_OPEN_STATUSES = ['placed', 'in_production', 'shipped'];
// CRM stages excluded from follow-up alerts (mirror crm.js getToday CLOSED_STAGES).
const FOLLOWUP_CLOSED_STAGES = ['won', 'lost', 'dormant'];
// A follow-up on a deal at/above this value shows its dollar amount.
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

// buildSignals — compose all sources; a thrown source drops only its group.
async function buildSignals({ now = new Date() } = {}) {
  const sources = [ordersAging(now), followUps(now)];
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
  toGroups,
  // constants
  AGE_RUNNING_LONG,
  AGE_POSSIBLY_LATE,
  BIG_DEAL,
  ITEM_CAP,
};
