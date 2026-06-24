// controllers/crm.js
//
// The unified CRM, built on the existing Client record (one row per company,
// keyed by companyKey — the same key Orders use). Nothing here changes how
// Client is used by orders/auto-fill; it only adds CRM read/write surfaces.
//
// Endpoints (all admin-only, mounted at /api/crm):
//   GET  /                       list (?stage=&area=&q=)
//   GET  /today                  the "who do I call today" engine
//   GET  /calendar?from=&to=     follow-ups in a date window (month grid)
//   GET  /pipeline               Kanban feed: per-stage groups + forecast
//   GET  /dashboard              one-shot aggregate: pipeline + follow-ups +
//                                activity + breakdowns + a prioritized heads-up feed
//   GET  /:companyKey            one record + its Orders
//   PATCH /:companyKey           upsert/update; supports log-touch & reschedule
//   POST /import                 bulk upsert from field-tracker rows / CSV

const Client = require('../models/Client');
const Order  = require('../models/Order');
const { deriveCompanyKey } = require('../models/Order'); // REUSE canonical key normalization
const PurchaseOrder = require('../models/PurchaseOrder');
const Transaction   = require('../models/Transaction');
// REUSE the finance definitions verbatim — the company money summary must match
// /api/finances exactly (same revenue/COGS/profit/margin math, same order-number
// normalization). Never re-derive finance numbers here.
const { summarizeCompanyFinance, normalizeOrderNumber } = require('./finances');
const { parseCsv, rowsToObjects, mapTrackerRow } = require('../utils/fieldTrackerImport');
// Business-timezone day boundaries. The server runs in UTC (ahead of the owner's
// US-Eastern clock), so every "today / overdue / due-today" decision reasons in
// America/New_York via these helpers — never the raw server clock. (Real audit
// instants like log `at` / lastContact stay untouched; only day-boundary
// comparisons route through here.) See utils/time.js.
const { etToday, etStartOfToday, dayDiffFromToday } = require('../utils/time');

const STAGES = Client.CRM_STAGES;
// Stages we never surface in the call engine — the deal is closed or parked.
const CLOSED_STAGES = ['won', 'lost', 'dormant'];

// Probability of closing per stage — drives the weighted pipeline forecast on
// /pipeline. won/customer are realized (1); lost/dormant carry no forecast (0).
// Exposed on the /pipeline payload so the board can label it consistently.
const STAGE_PROBABILITY = {
  lead:      0.1,
  contacted: 0.25,
  quoting:   0.5,
  sampling:  0.7,
  won:       1,
  customer:  1,
  lost:      0,
  dormant:   0,
};
const stageProbability = (stage) => (
  Object.prototype.hasOwnProperty.call(STAGE_PROBABILITY, stage) ? STAGE_PROBABILITY[stage] : 0
);

// Stages whose deals are still IN FLIGHT — money in play but not yet realized.
// These are the only stages that count toward "open pipeline" value. won &
// customer are closed-won (revenue realized, not open); lost & dormant are dead.
// (Distinct from the call-engine's CLOSED_STAGES, which keeps `customer` callable
// for retention — that's about who to call, not open deal value.)
const OPEN_STAGES = ['lead', 'contacted', 'quoting', 'sampling'];

// Compute the board summary from a flat list of { stage, dealValue } records.
// Pure (no DB) so it's unit-testable. Returns:
//   { totalOpenValue, weightedValue }
// - totalOpenValue: sum of dealValue across OPEN stages only.
// - weightedValue:  sum of dealValue × stageProbability across ALL stages.
function summarizePipeline(records) {
  let totalOpenValue = 0;
  let weightedValue = 0;
  for (const r of records || []) {
    const val = Number(r && r.dealValue) || 0;
    const stage = r && r.stage;
    if (OPEN_STAGES.includes(stage)) totalOpenValue += val;
    weightedValue += val * stageProbability(stage);
  }
  return {
    totalOpenValue: Math.round(totalOpenValue * 100) / 100,
    weightedValue:  Math.round(weightedValue * 100) / 100,
  };
}

// Day boundaries are computed in the BUSINESS timezone (America/New_York) — see
// the time-helper import above. etToday() gives the owner's calendar day and
// dayDiffFromToday() compares a stored whole-day field to it by calendar day, so
// "today / overdue / due-today" track the New-Jersey owner's clock even late in
// the evening when the UTC server has already rolled to tomorrow.

// Most-recent log entry (the log is appended chronologically; we don't assume
// it's sorted, so pick the max `at`).
function lastLogEntry(log) {
  if (!Array.isArray(log) || log.length === 0) return null;
  let best = null;
  for (const e of log) {
    if (!best || new Date(e.at || 0) >= new Date(best.at || 0)) best = e;
  }
  return best || null;
}

// ── Heads-up engine ────────────────────────────────────────────────────────────
// The "keep me on track" intelligence behind the dashboard. Pure (no DB) so it's
// unit-testable on synthetic Clients. classifyHeadsUp inspects ONE record and
// returns 0..n attention items; buildHeadsUp runs the whole set, sorts by
// priority, caps the surfaced list, and tallies per-type counts.
//
// An item: { type, companyKey, name, phone, message, severity, value, date }.
//   severity ∈ 'high' | 'med' | 'low'   value = dealValue (for sorting/labeling)
//
// Thresholds (tuned for a small shop's book of business; one place to adjust):
const HEADS_UP = {
  STALE_DAYS:     21,   // no log + no stage change in this many days = stale
  QUIET_DAYS:     14,   // a hot deal we haven't touched in this many days = hot_quiet
  HOT_VALUE:      2000, // dealValue at/above this is "hot" (top tier)
  HIGH_VALUE:     2000, // an overdue follow-up on a deal this big escalates to 'high'
  MAX_ITEMS:      25,   // cap on the surfaced feed (counts still reflect the full set)
};
// Rank severities high → low for sorting.
const SEVERITY_RANK = { high: 0, med: 1, low: 2 };

// Days between two epoch-ms instants (b - a), floored. Negative if b precedes a.
function daysBetween(aMs, bMs) {
  return Math.floor((bMs - aMs) / 86400000);
}

// Inspect one client (a lean POJO with the CRM fields) and return any heads-up
// items it earns.
//   nowMs    — current instant (epoch ms): drives elapsed-time signals (stale /
//              hot-quiet), which are genuinely "how long since" measures.
//   todayMs  — start-of-today in the BUSINESS timezone (epoch ms): the day
//              boundary the whole-day nextFollowUp is judged "overdue" against,
//              comparing ET calendar day to the follow-up's (UTC) calendar day so
//              a 6/24 follow-up isn't "overdue" until it's actually 6/24 in ET.
// Both are passed in (not read from the clock) so the function stays deterministic
// and unit-testable.
function classifyHeadsUp(c, nowMs, todayMs) {
  if (!c) return [];
  const stage = c.stage;
  const closed = CLOSED_STAGES.includes(stage); // won/lost/dormant — out of the funnel
  const items = [];

  const name  = c.companyName || c.clientName || c.companyKey;
  const phone = c.phone || ((c.contacts || []).find((x) => x && x.phone) || {}).phone || '';
  const value = Number(c.dealValue) || 0;
  const base  = { companyKey: c.companyKey, name, phone, value };

  const lc = c.lastContact ? new Date(c.lastContact).getTime() : null;
  const last = lastLogEntry(c.log);
  const lastLogMs = last && last.at ? new Date(last.at).getTime() : null;
  const updatedMs = c.updatedAt ? new Date(c.updatedAt).getTime() : null;

  // Whole-day follow-up vs the owner's today, compared by CALENDAR DAY (see
  // dayDiffFromToday): <0 overdue, 0 due today, >0 upcoming. null = none set.
  const nowDate = new Date(nowMs);
  const followDayDiff = c.nextFollowUp != null ? dayDiffFromToday(c.nextFollowUp, nowDate) : null;

  // overdue_followup — active deal whose follow-up day is before today's ET day.
  if (!closed && followDayDiff != null && followDayDiff < 0) {
    const overdueDays = -followDayDiff;
    items.push({
      ...base,
      type: 'overdue_followup',
      severity: value >= HEADS_UP.HIGH_VALUE ? 'high' : 'med',
      message: `Follow-up ${overdueDays === 1 ? '1 day' : `${overdueDays} days`} overdue`,
      date: c.nextFollowUp,
    });
  }

  // no_next_step — active deal with nothing scheduled (fall-through risk). Don't
  // double-flag an overdue one (that already demands action).
  if (!closed && c.nextFollowUp == null) {
    items.push({
      ...base,
      type: 'no_next_step',
      severity: value >= HEADS_UP.HOT_VALUE ? 'med' : 'low',
      message: 'No next step scheduled',
      date: null,
    });
  }

  // stale — active deal with no recent activity: latest of (last log / updatedAt)
  // is older than STALE_DAYS. updatedAt covers stage changes & field edits.
  if (!closed) {
    const lastTouchMs = Math.max(lastLogMs || 0, updatedMs || 0) || null;
    if (lastTouchMs != null) {
      const idleDays = daysBetween(lastTouchMs, nowMs);
      if (idleDays > HEADS_UP.STALE_DAYS) {
        items.push({
          ...base,
          type: 'stale',
          severity: value >= HEADS_UP.HOT_VALUE ? 'med' : 'low',
          message: `No activity in ${idleDays} days`,
          date: new Date(lastTouchMs).toISOString(),
        });
      }
    }
  }

  // hot_quiet — a top-tier deal we've gone quiet on: dealValue ≥ HOT_VALUE AND
  // lastContact older than QUIET_DAYS (or never). High-value + neglected = the
  // owner's biggest blind spot, so this rides high.
  if (!closed && value >= HEADS_UP.HOT_VALUE) {
    const quietDays = lc != null ? daysBetween(lc, nowMs) : null;
    if (lc == null || quietDays > HEADS_UP.QUIET_DAYS) {
      items.push({
        ...base,
        type: 'hot_quiet',
        severity: 'high',
        message: lc == null
          ? `Hot deal (${fmtUsd(value)}) — never contacted`
          : `Hot deal (${fmtUsd(value)}) quiet for ${quietDays} days`,
        date: c.lastContact || null,
      });
    }
  }

  return items;
}

// Whole-dollar USD for heads-up copy (no cents). Small + local so the engine has
// no UI deps.
function fmtUsd(n) {
  return `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

// Run classifyHeadsUp over a list of clients, sort the flattened items by
// severity (high→low) then value (desc) then soonest date, cap to MAX_ITEMS, and
// tally counts per type across the FULL (uncapped) set. `nowMs` is the current
// instant; `todayMs` is start-of-today in the business timezone (see
// classifyHeadsUp). Returns: { items, counts: { <type>: n, ... }, total }
function buildHeadsUp(clients, nowMs, todayMs) {
  const all = [];
  for (const c of clients || []) {
    for (const it of classifyHeadsUp(c, nowMs, todayMs)) all.push(it);
  }

  const counts = {};
  for (const it of all) counts[it.type] = (counts[it.type] || 0) + 1;

  all.sort((a, b) => {
    const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (s !== 0) return s;
    if (b.value !== a.value) return b.value - a.value;      // bigger deal first
    const ad = a.date ? new Date(a.date).getTime() : Infinity;
    const bd = b.date ? new Date(b.date).getTime() : Infinity;
    return ad - bd;                                          // then soonest/oldest date
  });

  return { items: all.slice(0, HEADS_UP.MAX_ITEMS), counts, total: all.length };
}

// GET /api/crm — list with optional filters, sorted by name. Lean.
async function listCrm(req, res) {
  try {
    const { stage, area, q, tag } = req.query;
    const filter = {};
    if (stage && STAGES.includes(stage)) filter.stage = stage;
    if (area) filter.area = area;
    if (tag && String(tag).trim()) filter.tags = String(tag).trim(); // match docs whose tags[] contains this tag
    if (q && String(q).trim()) {
      const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ companyName: rx }, { clientName: rx }, { companyKey: rx }];
    }
    const clients = await Client.find(filter).sort({ companyName: 1 }).lean();
    res.json({ clients });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// GET /api/crm/today — the call engine.
// Records with nextFollowUp <= end of today AND stage not in closed stages,
// sorted overdue-first then soonest. Returns a compact row per record plus a
// count summary { overdue, dueToday }.
async function getToday(req, res) {
  try {
    // "Due by end of the owner's today" = whole-day follow-up whose calendar day
    // is ≤ today's ET day. Whole-day fields sit at UTC midnight, so the cutoff is
    // the UTC midnight of the day AFTER today's ET day; anything strictly before
    // it has a UTC calendar day of today-or-earlier. (Using the ET day — not the
    // server's UTC day — is the fix: late-evening in NJ the server is already
    // "tomorrow".)
    const cutoff = new Date(Date.parse(`${etToday()}T00:00:00Z`) + 86400000);

    const docs = await Client.find({
      nextFollowUp: { $ne: null, $lt: cutoff },
      stage: { $nin: CLOSED_STAGES },
    })
      .sort({ nextFollowUp: 1 })   // soonest/most-overdue first (oldest date first)
      .lean();

    let overdue = 0;
    let dueToday = 0;
    const rows = docs.map((c) => {
      // Compare by ET calendar day (see dayDiffFromToday): < 0 = overdue, 0 = due today.
      const diff = dayDiffFromToday(c.nextFollowUp);
      const isOverdue = diff != null && diff < 0;
      if (isOverdue) overdue++; else dueToday++;
      const last = lastLogEntry(c.log);
      return {
        companyKey:   c.companyKey,
        name:         c.companyName || c.clientName || c.companyKey,
        phone:        c.phone || '',
        contacts:     c.contacts || [],
        stage:        c.stage,
        interestType: c.interestType || '',
        area:         c.area || '',
        nextFollowUp: c.nextFollowUp || null,
        lastContact:  c.lastContact || null,
        overdue:      !!isOverdue,
        lastLog:      last ? { at: last.at, text: last.text, kind: last.kind } : null,
      };
    });

    // ascending nextFollowUp already puts most-overdue first; that's exactly
    // "overdue-first then soonest". Keep as-is.
    res.json({
      summary: { overdue, dueToday, total: rows.length },
      rows,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// GET /api/crm/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
// Records whose nextFollowUp falls within [from, to] inclusive. Returns a slim
// shape suited to a month grid.
async function getCalendar(req, res) {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'from and to (YYYY-MM-DD) are required' });
    // Parse the day window explicitly in UTC: whole-day follow-ups are stored at
    // UTC midnight (their calendar day == their UTC day), and the frontend builds
    // the month grid in UTC, so a UTC window selects exactly the days requested
    // regardless of the server's own timezone. (No "today" is derived here.)
    const start = new Date(`${from}T00:00:00.000Z`);
    const end   = new Date(`${to}T23:59:59.999Z`);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ message: 'from/to must be valid YYYY-MM-DD dates' });
    }
    const docs = await Client.find({
      nextFollowUp: { $ne: null, $gte: start, $lte: end },
    })
      .sort({ nextFollowUp: 1 })
      .select('companyKey companyName clientName phone stage interestType area nextFollowUp lastContact')
      .lean();

    const events = docs.map((c) => ({
      companyKey:   c.companyKey,
      name:         c.companyName || c.clientName || c.companyKey,
      phone:        c.phone || '',
      stage:        c.stage,
      interestType: c.interestType || '',
      area:         c.area || '',
      nextFollowUp: c.nextFollowUp,
      lastContact:  c.lastContact || null,
    }));
    res.json({ from, to, events });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// GET /api/crm/pipeline — the Kanban board feed.
// Groups every company by stage and returns, per stage, a lean set of cards plus
// a count and summed dealValue, in canonical stage order. Also returns the
// overall { totalOpenValue, weightedValue } forecast and the probability map the
// weighting uses (so the UI can label it without hardcoding the numbers).
// Optional filters mirror the list endpoint (?area=&q=&tag=) so the board can be
// narrowed the same way Companies is.
async function getPipeline(req, res) {
  try {
    const { area, q, tag } = req.query;
    const filter = {};
    if (area) filter.area = area;
    if (tag && String(tag).trim()) filter.tags = String(tag).trim();
    if (q && String(q).trim()) {
      const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ companyName: rx }, { clientName: rx }, { companyKey: rx }];
    }

    const docs = await Client.find(filter)
      .select('companyKey companyName clientName dealValue nextFollowUp stage area interestType tags')
      .sort({ dealValue: -1, companyName: 1 })   // biggest deals first within each column
      .lean();

    // Seed every stage so empty columns still render in canonical order.
    const byStage = {};
    for (const s of STAGES) byStage[s] = { stage: s, count: 0, totalValue: 0, clients: [] };

    for (const c of docs) {
      const s = byStage[c.stage] ? c.stage : 'lead'; // defensive: bucket unknowns at the top
      const g = byStage[s];
      g.count += 1;
      g.totalValue += Number(c.dealValue) || 0;
      g.clients.push({
        companyKey:   c.companyKey,
        name:         c.companyName || c.clientName || c.companyKey,
        dealValue:    Number(c.dealValue) || 0,
        nextFollowUp: c.nextFollowUp || null,
        stage:        c.stage,
        area:         c.area || '',
        interestType: c.interestType || '',
        tags:         c.tags || [],
      });
    }

    const groups = STAGES.map((s) => {
      const g = byStage[s];
      return { ...g, totalValue: Math.round(g.totalValue * 100) / 100 };
    });

    res.json({
      groups,
      summary: summarizePipeline(docs),
      probability: STAGE_PROBABILITY,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// GET /api/crm/dashboard — the one-shot aggregate behind the Dashboard view.
// Computes EVERYTHING the dashboard needs in a single pass over Clients (honors
// an optional ?area= scope). Sections:
//   • pipeline   — per-stage { count, value } + totalOpenValue + weightedValue
//                  (same math as /pipeline, reusing summarizePipeline + the map).
//   • followUps  — { overdue, dueToday, dueThisWeek } counts over active deals.
//   • activity   — touches logged in the last 7 / 30 days (counts log[] by `at`).
//   • breakdowns — counts + open value grouped by area and by interestType.
//   • headsUp    — prioritized attention feed (see buildHeadsUp) + per-type counts.
async function getDashboard(req, res) {
  try {
    const { area } = req.query;
    const filter = {};
    if (area) filter.area = area;

    // One read; we only need the CRM fields (+ timestamps for staleness).
    const docs = await Client.find(filter)
      .select('companyKey companyName clientName phone contacts dealValue stage area interestType nextFollowUp lastContact log updatedAt')
      .lean();

    const now        = new Date();
    const nowMs      = now.getTime();
    // Day boundaries in the business timezone (see utils/time.js). startTodayMs
    // is passed to the heads-up engine; the follow-up buckets below classify by
    // ET calendar day directly via dayDiffFromToday.
    const startTodayMs = etStartOfToday(now).getTime();
    // Activity windows are genuine elapsed-time (touches in the last 7/30 days by
    // their real timestamp), so they stay instant-based — not day boundaries.
    const ms7  = nowMs - 7  * 86400000;
    const ms30 = nowMs - 30 * 86400000;

    // Per-stage buckets, seeded in canonical order so empty stages still render.
    const stageMap = {};
    for (const s of STAGES) stageMap[s] = { stage: s, count: 0, value: 0 };

    // Breakdown accumulators (keyed by the raw value; '' bucket = unset).
    const areaMap     = new Map();   // area  → { area, count, openValue }
    const interestMap = new Map();   // type  → { interestType, count, openValue }

    let overdue = 0, dueToday = 0, dueThisWeek = 0;
    let touches7 = 0, touches30 = 0;

    for (const c of docs) {
      const stage = stageMap[c.stage] ? c.stage : 'lead';
      const val   = Number(c.dealValue) || 0;
      const isOpen = OPEN_STAGES.includes(c.stage);

      stageMap[stage].count += 1;
      stageMap[stage].value += val;

      // Follow-up buckets — active (non-closed) deals only, matching /today.
      // Classified by ET calendar day (dayDiffFromToday): <0 overdue, 0 due
      // today, 1..7 within the rolling week — so the split agrees with the
      // owner's clock, not the server's UTC day.
      if (!CLOSED_STAGES.includes(c.stage) && c.nextFollowUp) {
        const diff = dayDiffFromToday(c.nextFollowUp, now);
        if (diff != null) {
          if (diff < 0) overdue += 1;
          else if (diff === 0) dueToday += 1;
          else if (diff <= 7) dueThisWeek += 1;
        }
      }

      // Activity — count individual touches by their timestamp.
      for (const e of (c.log || [])) {
        const t = e && e.at ? new Date(e.at).getTime() : NaN;
        if (!Number.isNaN(t)) {
          if (t >= ms7)  touches7  += 1;
          if (t >= ms30) touches30 += 1;
        }
      }

      // Breakdown by area (open value = only in-flight stages count toward $).
      const aKey = c.area || '';
      const a = areaMap.get(aKey) || { area: aKey, count: 0, openValue: 0 };
      a.count += 1;
      if (isOpen) a.openValue += val;
      areaMap.set(aKey, a);

      // Breakdown by interestType.
      const iKey = c.interestType || '';
      const i = interestMap.get(iKey) || { interestType: iKey, count: 0, openValue: 0 };
      i.count += 1;
      if (isOpen) i.openValue += val;
      interestMap.set(iKey, i);
    }

    const round2 = (n) => Math.round(n * 100) / 100;
    const stages = STAGES.map((s) => ({ ...stageMap[s], value: round2(stageMap[s].value) }));
    const summary = summarizePipeline(docs);

    const byArea = Array.from(areaMap.values())
      .map((x) => ({ ...x, openValue: round2(x.openValue) }))
      .sort((a, b) => b.openValue - a.openValue || b.count - a.count);
    const byInterest = Array.from(interestMap.values())
      .map((x) => ({ ...x, openValue: round2(x.openValue) }))
      .sort((a, b) => b.openValue - a.openValue || b.count - a.count);

    const heads = buildHeadsUp(docs, nowMs, startTodayMs);

    res.json({
      generatedAt: now.toISOString(),
      area: area || null,
      totalCompanies: docs.length,
      pipeline: {
        stages,
        totalOpenValue: summary.totalOpenValue,
        weightedValue:  summary.weightedValue,
        probability:    STAGE_PROBABILITY,
      },
      followUps: { overdue, dueToday, dueThisWeek },
      activity:  { touches7, touches30 },
      breakdowns: { byArea, byInterest },
      headsUp: {
        items:  heads.items,
        counts: heads.counts,
        total:  heads.total,
      },
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// GET /api/crm/:companyKey — one record (get-or-create stub) + its Orders.
async function getOne(req, res) {
  try {
    const key = req.params.companyKey;
    if (!key) return res.status(400).json({ message: 'companyKey required' });

    let client = await Client.findOne({ companyKey: key }).lean();
    if (!client) {
      // Bootstrap an empty stub from any existing order so the record exists
      // and lines up with order history — mirrors controllers/clients.js.
      const sample = await Order.findOne({ companyKey: key })
        .sort({ updatedAt: -1 })
        .select('companyName clientName')
        .lean();
      const created = await Client.create({
        companyKey:  key,
        companyName: (sample && sample.companyName) || '',
        clientName:  (sample && sample.clientName)  || '',
      });
      client = created.toObject();
    }

    const orders = await Order.find({ companyKey: key })
      .sort({ orderDate: -1, createdAt: -1 })
      .select('projectNumber orderNumber status paid totalValue cogs orderDate createdAt')
      .lean();

    // ── Linked POs ──────────────────────────────────────────────────────────────
    // POs hang off Orders (PurchaseOrder.orderId). Gather this company's order ids
    // → their POs, newest-first, as lean cards.
    const orderIds = orders.map((o) => o._id);
    const poDocs = orderIds.length
      ? await PurchaseOrder.find({ orderId: { $in: orderIds } })
          .sort({ date: -1, createdAt: -1 })
          .select('poNumber vendorName grandTotal orderId date')
          .lean()
      : [];
    const pos = poDocs.map((p) => ({
      _id:        p._id,
      poNumber:   p.poNumber || '',
      vendorName: p.vendorName || '',
      grandTotal: Number(p.grandTotal) || 0,
      orderId:    p.orderId,
      date:       p.date || null,
    }));

    // ── Finance summary ─────────────────────────────────────────────────────────
    // The company's whole money story, computed by REUSING the finance math
    // (summarizeCompanyFinance — same revenue/COGS/profit/margin definitions as
    // /api/finances). The ledger keys by digits-only order number, so we bridge by
    // normalizing this company's Order numbers and pulling exactly those Tx rows.
    const orderNums = [...new Set(
      orders.map((o) => normalizeOrderNumber(o.orderNumber)).filter(Boolean),
    )];
    const txns = orderNums.length
      ? await Transaction.find({ orderNumber: { $in: orderNums } })
          .select('type category amount isCredit orderNumber')
          .lean()
      : [];
    const finance = summarizeCompanyFinance(orders, txns);

    res.json({ client, orders, pos, finance });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// Fields a normal PATCH may set directly.
const PATCHABLE = [
  'companyName', 'clientName', 'email', 'phone', 'paymentTerms',
  'defaultPrinter', 'defaultSupplier', 'defaultMarkup', 'notes',
  'stage', 'nextFollowUp', 'lastContact', 'area', 'interestType',
  'dealValue', 'contacts', 'source', 'tags', 'lostReason',
];

// PATCH /api/crm/:companyKey — upsert/update CRM fields.
// Two helper intents (composable with plain field edits):
//   • log a touch: { logText, kind?, nextFollowUp? }
//       → append { at: now, text: logText, kind } to log
//       → set lastContact = now
//       → set nextFollowUp if provided
//   • reschedule:  { nextFollowUp }  (no logText)
//       → just move the date (powers calendar drag-and-drop)
// Get-or-create by companyKey (reusing normalization is unnecessary here — the
// key is supplied — but we never let a non-empty value be clobbered implicitly).
async function patchOne(req, res) {
  try {
    const key = req.params.companyKey;
    if (!key) return res.status(400).json({ message: 'companyKey required' });
    const body = req.body || {};

    const set = {};
    const push = {};

    // Plain field edits.
    for (const f of PATCHABLE) {
      if (f in body) {
        if (f === 'stage' && body.stage && !STAGES.includes(body.stage)) {
          return res.status(400).json({ message: `invalid stage "${body.stage}"` });
        }
        set[f] = body[f];
      }
    }

    // Tags: normalize to a clean string[] — trimmed, non-empty, de-duped
    // (case-insensitively, keeping first spelling) — so the field stays tidy
    // regardless of what the client sends.
    if ('tags' in body) {
      const seen = new Set();
      const clean = [];
      for (const t of (Array.isArray(body.tags) ? body.tags : [])) {
        const s = String(t == null ? '' : t).trim();
        if (!s) continue;
        const lc = s.toLowerCase();
        if (seen.has(lc)) continue;
        seen.add(lc);
        clean.push(s);
      }
      set.tags = clean;
    }

    // lostReason couples to the stage:
    //   • moving INTO 'lost' → keep the provided reason (or '' if none).
    //   • moving to any OTHER stage → clear a stale reason unless the caller is
    //     explicitly setting one in the same request.
    // A bare lostReason edit (no stage change) just passes through via PATCHABLE.
    if ('stage' in body) {
      if (body.stage === 'lost') {
        if (!('lostReason' in body)) set.lostReason = set.lostReason || '';
      } else if (!('lostReason' in body)) {
        set.lostReason = '';
      }
    }

    // Intent: log a touch.
    const hasLog = typeof body.logText === 'string' && body.logText.trim() !== '';
    if (hasLog) {
      const now = new Date();
      push.log = { at: now, text: body.logText.trim(), kind: (body.kind || 'note') };
      set.lastContact = now;
      if ('nextFollowUp' in body) set.nextFollowUp = body.nextFollowUp || null;
    }

    // Intent: reschedule (only when not also logging — logging already handled
    // nextFollowUp above). A bare { nextFollowUp } just moves the date.
    if (!hasLog && 'nextFollowUp' in body) {
      set.nextFollowUp = body.nextFollowUp || null;
    }

    set.companyKey = key;

    const update = {};
    if (Object.keys(set).length)  update.$set  = set;
    if (Object.keys(push).length) update.$push = push;

    const client = await Client.findOneAndUpdate(
      { companyKey: key },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();

    res.json({ client });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// ── Import ────────────────────────────────────────────────────────────────────
// Merge one mapped tracker patch into the (possibly existing) Client doc.
// Rules:
//   • fill blanks only — never clobber a non-empty existing field with an
//     empty import value;
//   • dates: set lastContact/nextFollowUp only when parsed AND (empty before OR
//     the imported date is newer for lastContact / sooner-but-future is fine);
//   • contacts: add the imported primary contact if not already present (by
//     name+email);
//   • log: append all import notes (history is additive);
//   • stage: only upgrade a default/empty stage — don't downgrade a record the
//     owner already advanced.
// Returns 'created' | 'updated' | 'skipped'.
async function applyMappedRow(mapped) {
  if (mapped._skip || !mapped.companyKey) return 'skipped';
  const key = mapped.companyKey;

  let doc = await Client.findOne({ companyKey: key });
  const isNew = !doc;
  if (!doc) {
    doc = new Client({ companyKey: key, source: 'field-tracker' });
  }

  // Names / scalar text — fill blanks only.
  if (mapped.companyName && !doc.companyName) doc.companyName = mapped.companyName;
  if (mapped.area && !doc.area) doc.area = mapped.area;
  if (mapped.phone && !doc.phone) doc.phone = mapped.phone;
  if (mapped.email && !doc.email) doc.email = mapped.email;
  if (mapped.interestType && !doc.interestType) doc.interestType = mapped.interestType;
  if (!doc.source) doc.source = 'field-tracker';

  // Stage: only set when the import has a stage AND the doc is still at the
  // default 'lead' (or empty) — never override an owner-advanced stage.
  if (mapped.stage && (!doc.stage || doc.stage === 'lead')) {
    doc.stage = mapped.stage;
  }

  // Dates. lastContact: take the newer of existing/import. nextFollowUp: fill
  // if empty, otherwise keep the EARLIER upcoming date (don't push a call later).
  if (mapped.lastContact) {
    if (!doc.lastContact || mapped.lastContact > doc.lastContact) doc.lastContact = mapped.lastContact;
  }
  if (mapped.nextFollowUp) {
    if (!doc.nextFollowUp || mapped.nextFollowUp < doc.nextFollowUp) doc.nextFollowUp = mapped.nextFollowUp;
  }

  // Primary contact — add if a matching one (by name+email, case-insensitive)
  // isn't already on the record.
  if (mapped.contact) {
    const c = mapped.contact;
    const exists = (doc.contacts || []).some((ec) =>
      (ec.name || '').toLowerCase() === (c.name || '').toLowerCase() &&
      (ec.email || '').toLowerCase() === (c.email || '').toLowerCase());
    if (!exists && (c.name || c.email || c.phone)) doc.contacts.push(c);
  }

  // Log notes — always append (history is additive). De-dupe identical
  // (kind+text) lines that are already present so re-importing the same file
  // doesn't pile up duplicates.
  const existingLogKeys = new Set((doc.log || []).map((l) => `${l.kind} ${l.text}`));
  for (const ln of (mapped.logs || [])) {
    const k = `${ln.kind} ${ln.text}`;
    if (!existingLogKeys.has(k)) {
      doc.log.push({ at: new Date(), text: ln.text, kind: ln.kind });
      existingLogKeys.add(k);
    }
  }

  await doc.save();
  return isNew ? 'created' : 'updated';
}

// POST /api/crm/import — accepts EITHER:
//   { rows: [ { "Company Name": ..., ... }, ... ] }   (objects keyed by header)
//   { rows: [...] } where rows already match canonical keys
//   { csv: "<raw csv text>" }                          (we parse it)
//   a bare JSON array body                              (treated as rows)
// Upserts Client/CRM by companyKey; never wipes existing data.
// Returns { created, updated, skipped, total }.
async function importRows(req, res) {
  try {
    const body = req.body;
    const year = Number(body && body.year) || 2026;

    let mappedRows = [];

    if (body && typeof body.csv === 'string' && body.csv.trim()) {
      const objs = rowsToObjects(parseCsv(body.csv));
      mappedRows = objs.map((o) => mapTrackerRow(o, { year }));
    } else {
      let rows = [];
      if (Array.isArray(body)) rows = body;
      else if (body && Array.isArray(body.rows)) rows = body.rows;
      else return res.status(400).json({ message: 'Provide { rows: [...] } or { csv: "..." }' });

      mappedRows = rows.map((r) => {
        // Accept either header-keyed objects ("Company Name") or canonical keys
        // ("companyName"). Normalize header-keyed → canonical via a tiny shim.
        const canon = normalizeRowKeys(r);
        return mapTrackerRow(canon, { year });
      });
    }

    let created = 0, updated = 0, skipped = 0;
    for (const mapped of mappedRows) {
      let outcome;
      try {
        outcome = await applyMappedRow(mapped);
      } catch (rowErr) {
        // Don't let one bad row abort the whole import.
        outcome = 'skipped';
      }
      if (outcome === 'created') created++;
      else if (outcome === 'updated') updated++;
      else skipped++;
    }

    res.json({ created, updated, skipped, total: mappedRows.length });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// Accept rows keyed by the owner's headers OR by canonical names; produce a
// canonical-keyed object that mapTrackerRow understands.
const HEADER_TO_CANON = {
  'company name': 'companyName',
  'owner / contact': 'contact',
  'owner/contact': 'contact',
  'contact': 'contact',
  'phone': 'phone',
  'email': 'email',
  'area': 'area',
  'interested?': 'interested',
  'interested': 'interested',
  'status': 'status',
  'last contact': 'lastContact',
  'next contact': 'nextContact',
  'next action': 'nextAction',
  'notes': 'notes',
  // canonical passthroughs
  'companyname': 'companyName',
  'lastcontact': 'lastContact',
  'nextcontact': 'nextContact',
  'nextaction': 'nextAction',
};
function normalizeRowKeys(row) {
  if (!row || typeof row !== 'object') return {};
  const out = {};
  for (const k of Object.keys(row)) {
    const canon = HEADER_TO_CANON[String(k).trim().toLowerCase()];
    if (canon) out[canon] = row[k];
  }
  return out;
}

module.exports = {
  listCrm,
  getToday,
  getCalendar,
  getPipeline,
  getDashboard,
  getOne,
  patchOne,
  importRows,
  // exported for tests / reuse
  applyMappedRow,
  normalizeRowKeys,
  summarizePipeline,
  stageProbability,
  STAGE_PROBABILITY,
  classifyHeadsUp,
  buildHeadsUp,
  HEADS_UP,
};
