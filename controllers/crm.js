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
const {
  parseCsv, rowsToObjects, rowsToObjectsWithMeta, mapTrackerRow,
  matchKey: deriveMatchKey, normPhone, normEmail,
  canonHeader, formatLabel, detectFormat,
} = require('../utils/fieldTrackerImport');
// Business-timezone day boundaries. The server runs in UTC (ahead of the owner's
// US-Eastern clock), so every "today / overdue / due-today" decision reasons in
// America/New_York via these helpers — never the raw server clock. (Real audit
// instants like log `at` / lastContact stay untouched; only day-boundary
// comparisons route through here.) See utils/time.js.
const { etToday, etStartOfToday, dayDiffFromToday } = require('../utils/time');

const STAGES = Client.CRM_STAGES;
// Stages we never surface in the call engine — the deal is closed or parked.
const CLOSED_STAGES = ['won', 'lost', 'dormant'];

// Funnel rank for "promote-up-only" stage moves on import / order-promotion.
// Higher = further along. won & customer are both terminal-positive (rank 5) so
// neither downgrades the other. lost/dormant are DELIBERATE end states and are
// intentionally OMITTED here — promoteStage refuses to move into OR out of them,
// so an order can never silently resurrect a deal the owner closed, and an
// owner-closed stage is never regressed by an import.
const STAGE_RANK = {
  lead: 0, contacted: 1, quoting: 2, sampling: 3, won: 5, customer: 5,
};
// Move `current` toward `target` ONLY if that's a forward move on the funnel and
// NEITHER stage is a closed/parked end state (lost/dormant). Returns the stage to
// keep. Never regresses; never touches lost/dormant.
function promoteStage(current, target) {
  const cur = current || 'lead';
  if (!target || target === cur) return cur;
  // Don't disturb a deliberate closed/parked stage, and don't promote INTO one.
  if (cur === 'lost' || cur === 'dormant') return cur;
  if (target === 'lost' || target === 'dormant') return cur;
  const cr = STAGE_RANK[cur] != null ? STAGE_RANK[cur] : 0;
  const tr = STAGE_RANK[target] != null ? STAGE_RANK[target] : 0;
  return tr > cr ? target : cur;
}

// Archived (soft-deleted) records are excluded from every WORKING surface —
// /today, /dashboard, /pipeline, /calendar, and the default /list. They still
// exist (and their Orders still link by companyKey); they just drop out of the
// day-to-day. Spread this into a find() filter. `{ archived: { $ne: true } }`
// (not `archived: false`) so pre-existing docs with no archived field still
// match.
const NOT_ARCHIVED = { archived: { $ne: true } };

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

  // DOWN-RANK cold / never-worked leads so the feed isn't dominated by them. The
  // "needs attention" feed is for deals in motion (overdue, hot-and-quiet,
  // warm-but-stalled) — a never-contacted cold prospect with no scheduled step is
  // NOT today's priority. A record is "cold dead-weight" when it's a bare lead
  // (stage 'lead') that's either tagged 'cold'/'meta-ad' OR has never been
  // contacted (no lastContact, no human log) AND has nothing scheduled. We
  // SUPPRESS the low-signal no_next_step/stale flags for those (they'd otherwise
  // bury the real work); a real follow-up date or a deal value still surfaces them.
  const tags = (c.tags || []).map((t) => String(t).toLowerCase());
  const everContacted = lc != null || (c.log || []).some((l) => ['call', 'text', 'email', 'visit'].includes(l && l.kind));
  const coldDeadWeight = stage === 'lead'
    && (tags.includes('cold') || tags.includes('meta-ad') || !everContacted)
    && value < HEADS_UP.HOT_VALUE;

  // Whole-day follow-up vs the owner's today, compared by CALENDAR DAY (see
  // dayDiffFromToday): <0 overdue, 0 due today, >0 upcoming. null = none set.
  const nowDate = new Date(nowMs);
  const followDayDiff = c.nextFollowUp != null ? dayDiffFromToday(c.nextFollowUp, nowDate) : null;

  // overdue_followup — active deal whose follow-up day is before today's ET day.
  // (Always surfaces, even for a cold lead: the owner explicitly scheduled it.)
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
  // double-flag an overdue one (that already demands action). SKIP cold dead-weight
  // — a never-worked cold prospect having "no next step" is the normal state, not
  // an alert worth the owner's attention.
  if (!closed && c.nextFollowUp == null && !coldDeadWeight) {
    items.push({
      ...base,
      type: 'no_next_step',
      severity: value >= HEADS_UP.HOT_VALUE ? 'med' : 'low',
      message: 'No next step scheduled',
      date: null,
    });
  }

  // stale — active deal with no recent activity: latest of (last log / updatedAt)
  // is older than STALE_DAYS. updatedAt covers stage changes & field edits. SKIP
  // cold dead-weight (a cold lead going untouched isn't "stalling" — it never
  // started).
  if (!closed && !coldDeadWeight) {
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

// Build a global "find anyone" $or from a free-text query. Matches across the
// company identity AND people on the card (contact name/email/phone) AND tags —
// so the owner can "search for a specific person at any stage", Notion-style,
// from anywhere (today / calendar / pipeline / companies). Phone matching also
// tries the digits-only form so "(201) 555-1212" finds a stored "201-555-1212".
// Returns null for an empty query (caller then applies no text constraint).
function searchOr(q) {
  const term = String(q == null ? '' : q).trim();
  if (!term) return null;
  const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const or = [
    { companyName: rx },
    { clientName: rx },
    { companyKey: rx },
    { email: rx },
    { phone: rx },
    { tags: rx },                       // tag contains the term
    { 'contacts.name': rx },
    { 'contacts.email': rx },
    { 'contacts.phone': rx },
  ];
  // If the term has ≥7 digits, also match a contact/company phone by its raw
  // digits (handles formatting differences without storing a normalized copy).
  const digits = term.replace(/\D/g, '');
  if (digits.length >= 7) {
    const drx = new RegExp(digits.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    or.push({ phone: drx }, { 'contacts.phone': drx });
  }
  return or;
}

// GET /api/crm — list with optional filters, sorted by name. Lean.
// When ?q= is present it's a GLOBAL search: stage/tag filters are IGNORED so the
// owner finds a person/company at ANY stage (the whole point of the search box).
async function listCrm(req, res) {
  try {
    const { stage, area, q, tag, archived } = req.query;
    // Default list EXCLUDES archived; ?archived=1 shows only archived, =all shows
    // everything (for an "Archived" tab / restore surface).
    const filter = {};
    if (archived === '1' || archived === 'true') filter.archived = true;
    else if (archived === 'all') { /* no archived constraint */ }
    else Object.assign(filter, NOT_ARCHIVED);

    const or = searchOr(q);
    if (or) {
      // Global search: match anywhere, across every stage. Don't constrain by
      // stage/tag (those are browse filters, not search) — area still scopes if
      // the caller set it, so a regional global search is possible.
      filter.$or = or;
      if (area) filter.area = area;
    } else {
      if (stage && STAGES.includes(stage)) filter.stage = stage;
      if (area) filter.area = area;
      if (tag && String(tag).trim()) filter.tags = String(tag).trim(); // tags[] contains this tag
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
      ...NOT_ARCHIVED,
      nextFollowUp: { $ne: null, $lt: cutoff },
      stage: { $nin: CLOSED_STAGES },
    })
      .sort({ nextFollowUp: 1 })   // soonest/most-overdue first (oldest date first)
      .lean();

    // Which of these companies have ≥1 Order (⇒ customers)? One batched query.
    const withOrders = await keysWithOrders(docs.map((c) => c.companyKey));

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
        address:      c.address || '',
        area:         c.area || '',
        nextFollowUp: c.nextFollowUp || null,
        lastContact:  c.lastContact || null,
        overdue:      !!isOverdue,
        isCustomer:   withOrders.has(c.companyKey),
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
      ...NOT_ARCHIVED,
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
    const filter = { ...NOT_ARCHIVED };
    if (area) filter.area = area;
    // ?q= is a global search (contacts/tags/identity) — same behavior as /list.
    const or = searchOr(q);
    if (or) filter.$or = or;
    else if (tag && String(tag).trim()) filter.tags = String(tag).trim();

    const docs = await Client.find(filter)
      .select('companyKey companyName clientName dealValue nextFollowUp stage address area interestType tags')
      .sort({ dealValue: -1, companyName: 1 })   // biggest deals first within each column
      .lean();

    // Which companies have ≥1 Order (⇒ customers)? One batched query.
    const withOrders = await keysWithOrders(docs.map((c) => c.companyKey));

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
        address:      c.address || '',
        area:         c.area || '',
        interestType: c.interestType || '',
        tags:         c.tags || [],
        isCustomer:   withOrders.has(c.companyKey),
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
    const filter = { ...NOT_ARCHIVED };
    if (area) filter.area = area;

    // One read; we only need the CRM fields (+ timestamps for staleness, + tags
    // so the heads-up engine can down-rank cold/meta-ad leads, + address).
    const docs = await Client.find(filter)
      .select('companyKey companyName clientName phone contacts dealValue stage address area interestType nextFollowUp lastContact log tags updatedAt')
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

    // Customer reconciliation: how many of these companies actually have ≥1
    // Order. This is the authoritative "customers" number (order reality), which
    // can exceed the count stored under the 'customer'/'won' stages if some
    // records' stages are stale — surfacing it lets the owner see the true figure
    // and is what the one-time promote script reconciles into the stored stage.
    const withOrders = await keysWithOrders(docs.map((c) => c.companyKey));
    const customersWithOrders = docs.reduce((n, c) => n + (withOrders.has(c.companyKey) ? 1 : 0), 0);

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
      customersWithOrders, // authoritative customer count from order reality
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

// Loose normalization of a company display name for cross-referencing a
// Transaction's free-text `party` against a company. Lowercase + alnum-only, so
// "Acme, Inc." and "acme inc" collapse together. '' for nothing.
function looseName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Pure transaction-scoping (the LEAK FIX core): keep a Tx if its order number is
// uniquely ours (not in sharedNums), else require its party to match one of our
// names. No DB — unit-testable. `ownNames`/`sharedNums` are Sets of normalized
// names / normalized numbers. `nameKey` is the name-normalizer used to build
// ownNames (defaults to looseName); companyFinance passes deriveMatchKey so
// "Acme" matches "Acme LLC" and a company's own row isn't dropped over a suffix.
function scopeCompanyTransactions(rows, { ownNames, sharedNums, nameKey = looseName }) {
  return (rows || []).filter((t) => {
    const num = normalizeOrderNumber(t.orderNumber);
    if (!sharedNums.has(num)) return true;               // uniquely ours -> count
    const party = nameKey(t.party);                       // collided -> party must match
    return party && ownNames.has(party);
  });
}

// Company finance rollup — the LEAK FIX (MONEY).
//
// The bug: Transactions key only by a digits-only order number. Two different
// companies can reuse the same order number (e.g. both have an "#21"). The old
// code pulled every Transaction whose number was in THIS company's set and
// summed them all — so company A's page folded in company B's "#21" money.
//
// The fix scopes a Transaction to this company two ways, BOTH required to count:
//   1) its normalized order number is one of THIS company's Orders' numbers, AND
//   2) its `party` matches a name this company is known by — derived from the
//      Orders themselves (companyName/clientName). When a number is owned by
//      EXACTLY ONE company in the system, the party gate is a no-op (the row is
//      unambiguously ours); the gate only bites when a number collides across
//      companies, dropping the other company's rows. A Tx with a blank party
//      that shares a collided number can't be attributed, so it's left out
//      (better to under- than over-count someone else's revenue).
async function companyFinance(orders) {
  const orderNums = [...new Set(
    (orders || []).map((o) => normalizeOrderNumber(o.orderNumber)).filter(Boolean),
  )];
  if (!orderNums.length) return summarizeCompanyFinance(orders || [], []);

  // The names this company answers to (for the party gate). We normalize with
  // the SAME corporate-suffix-stripping key the dedup uses (deriveMatchKey), so
  // "Acme" (on the Order) and "Acme LLC" (on a Transaction's party) match - this
  // company's own row is never dropped just because the party spelling carries a
  // suffix. (looseName alone would treat "acme" != "acmellc".)
  const nameKey = (s) => deriveMatchKey(s, '');
  const ownNames = new Set();
  for (const o of orders || []) {
    const cn = nameKey(o.companyName); if (cn) ownNames.add(cn);
    const ln = nameKey(o.clientName);  if (ln) ownNames.add(ln);
  }

  const rows = await Transaction.find({ orderNumber: { $in: orderNums } })
    .select('type category amount isCredit orderNumber party receiptUrl')
    .lean();

  // Which of our order numbers are shared with at least one OTHER company? Only
  // those need the party gate; uniquely-ours numbers always count (so we never
  // drop a legitimate row just because its party text differs slightly). We
  // detect collisions from BOTH sources that can carry a number:
  //   • Order docs   (another company has an Order with the same number), and
  //   • the Transactions themselves (another company's ledger row reused the
  //     number even with no Order) - this closes the gap where a Tx-only
  //     collision would otherwise leak in.
  const ownersByNum = new Map();
  const addOwner = (num, name) => {
    if (!num || !orderNums.includes(num)) return;
    const key = nameKey(name);
    if (!key) return;
    const set = ownersByNum.get(num) || new Set();
    set.add(key);
    ownersByNum.set(num, set);
  };
  const colliding = await Order.find({ orderNumber: { $ne: '' } })
    .select('orderNumber companyName clientName').lean();
  for (const o of colliding) {
    const num = normalizeOrderNumber(o.orderNumber);
    addOwner(num, o.companyName);
    addOwner(num, o.clientName);
  }
  // Transaction-level owners (party text) for the same numbers we pulled.
  for (const t of rows) addOwner(normalizeOrderNumber(t.orderNumber), t.party);

  const sharedNums = new Set();
  for (const [num, owners] of ownersByNum) {
    for (const owner of owners) {
      if (!ownNames.has(owner)) { sharedNums.add(num); break; } // a non-us owner -> collided
    }
  }

  // Scope with the matchKey-based name normalization so the party gate uses the
  // same notion of "our name" we built ownNames with.
  const scoped = scopeCompanyTransactions(rows, { ownNames, sharedNums, nameKey });

  return summarizeCompanyFinance(orders || [], scoped);
}

// GET /api/crm/:companyKey — one record (get-or-create stub) + its Orders.
async function getOne(req, res) {
  try {
    const key = req.params.companyKey;
    if (!key) return res.status(400).json({ message: 'companyKey required' });

    let client = await Client.findOne({ companyKey: key }).lean();
    if (!client) {
      // Only AUTO-CREATE a record when there's a real Order with this key to
      // bootstrap from (so the CRM record lines up with order history — mirrors
      // controllers/clients.js). A bare GET of an unknown key must NOT mint a
      // ghost company (the old behavior littered the CRM with empty records every
      // time the UI probed a key). No order → 404; the caller treats it as
      // "doesn't exist yet".
      const sample = await Order.findOne({ companyKey: key })
        .sort({ updatedAt: -1 })
        .select('companyName clientName')
        .lean();
      if (!sample) {
        return res.status(404).json({ message: 'No CRM record for that key yet.' });
      }
      // Race-safe get-or-create: upsert on the unique companyKey so two
      // concurrent loads can't both insert (the old create() threw E11000 on the
      // loser). $setOnInsert only writes on a genuine insert, so an existing doc
      // is returned untouched.
      client = await Client.findOneAndUpdate(
        { companyKey: key },
        {
          $setOnInsert: {
            companyKey:  key,
            companyName: sample.companyName || '',
            clientName:  sample.clientName  || '',
            matchKey:    deriveMatchKey(sample.companyName, sample.clientName),
            source:      'order',
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
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
    const finance = await companyFinance(orders);

    // isCustomer is AUTHORITATIVE from order reality: a company with ≥1 linked
    // Order is a customer, full stop — even if its stored stage is stale (e.g. an
    // older import left it at 'lead'). The frontend renders "Customer" off this
    // boolean so it's reliable BEFORE the one-time promote script runs. The
    // promote script fixes the stored `stage`; this keeps the UI correct in the
    // meantime.
    const isCustomer = orders.length > 0;

    res.json({ client: { ...client, isCustomer }, orders, pos, finance, isCustomer });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// Fields a normal PATCH may set directly.
const PATCHABLE = [
  'companyName', 'clientName', 'email', 'phone', 'paymentTerms',
  'defaultPrinter', 'defaultSupplier', 'defaultMarkup', 'notes',
  'stage', 'nextFollowUp', 'lastContact', 'address', 'area', 'interestType',
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
// Pure import-merge policy: mutate `doc` (a plain object OR a mongoose doc) in
// place according to THE CONTRACT, given the mapped row and whether the doc is
// brand-new. No DB here, so the safety rules are unit-testable directly:
//   - fill-blanks-only for scalars
//   - stage only upgrades from default/empty (never downgrades owner work)
//   - lastContact = newer-of (monotonic)
//   - nextFollowUp SEEDED ON CREATE ONLY (never moved on update -> owner
//     reschedules survive; a cleared follow-up is never resurrected)
//   - contacts matched by normalized phone OR email, then blank-filled; new
//     people appended (no duplicate spawning)
//   - log de-duped by (kind + dedupKey) so re-import never piles up rows
function applyImportToDoc(doc, mapped, isNew, opts = {}) {
  if (!Array.isArray(doc.contacts)) doc.contacts = doc.contacts || [];
  if (!Array.isArray(doc.log)) doc.log = doc.log || [];
  if (!Array.isArray(doc.tags)) doc.tags = doc.tags || [];

  // Names / scalar text - fill blanks only.
  if (mapped.companyName && !doc.companyName) doc.companyName = mapped.companyName;
  if (mapped.clientName && !doc.clientName) doc.clientName = mapped.clientName;
  if (!doc.matchKey && mapped.matchKey) doc.matchKey = mapped.matchKey;
  if (mapped.area && !doc.area) doc.area = mapped.area;
  if (mapped.address && !doc.address) doc.address = mapped.address;
  if (mapped.phone && !doc.phone) doc.phone = mapped.phone;
  if (mapped.email && !doc.email) doc.email = mapped.email;
  if (mapped.interestType && !doc.interestType) doc.interestType = mapped.interestType;
  // dealValue: fill a blank/zero only — never overwrite an owner-entered value.
  if (mapped.dealValue && !(Number(doc.dealValue) > 0)) doc.dealValue = mapped.dealValue;
  // Provenance: where the RECORD came from. Set on create only (don't relabel an
  // existing record's origin). The import's source label drives it.
  if (!doc.source) doc.source = mapped.provenance || 'field-tracker';

  // Stage: PROMOTE-UP-ONLY. The import may carry a status-derived stage, and the
  // controller may flag that this company has ≥1 linked Order (hasOrders) — in
  // which case it's a CUSTOMER, never a lead. We take the furthest-along of the
  // candidates but NEVER regress what the owner already advanced (won stays won,
  // a manual 'sampling' isn't pulled back to 'customer', etc.). promoteStage
  // moves up the funnel rank only.
  //   - an order (on the row OR already linked) ⇒ at least 'customer'
  //   - else the status-mapped stage, but only from a default/empty/lead doc
  const hasOrders = !!opts.hasOrders || !!mapped.hasOrderNumber;
  // First, the status-derived stage — original contract: only fills a doc still
  // sitting at the import-default floor (empty / 'lead'); never overrides an
  // owner-advanced stage. (When the row carries an order, mapped.stage is already
  // 'customer'.)
  if (mapped.stage && (!doc.stage || doc.stage === 'lead')) {
    doc.stage = mapped.stage;
  }
  // Then order-promotion: a linked Order (on the row OR already in the DB) means
  // CUSTOMER. promoteStage moves UP only and refuses to touch lost/dormant, so a
  // won deal stays won, a manual mid-funnel stage isn't regressed, and a
  // deliberately-closed deal isn't resurrected by an order.
  if (hasOrders) {
    doc.stage = promoteStage(doc.stage, 'customer');
  }

  // Tags: union the import's temperature tags (hot/warm/room-temp/cold) in,
  // case-insensitively, without clobbering existing owner tags.
  if (Array.isArray(mapped.tags) && mapped.tags.length) {
    const seen = new Set(doc.tags.map((t) => String(t).toLowerCase()));
    for (const t of mapped.tags) {
      const s = String(t || '').trim();
      if (s && !seen.has(s.toLowerCase())) { doc.tags.push(s); seen.add(s.toLowerCase()); }
    }
  }

  // lastContact: monotonic high-water mark - take the NEWER of existing/import.
  if (mapped.lastContact) {
    if (!doc.lastContact || mapped.lastContact > doc.lastContact) doc.lastContact = mapped.lastContact;
  }
  // nextFollowUp: SEED ON CREATE ONLY (core idempotency fix).
  if (isNew && mapped.nextFollowUp) doc.nextFollowUp = mapped.nextFollowUp;

  // Contacts - match by normalized PHONE or EMAIL, then merge blanks; else append.
  for (const c of (mapped.contacts || [])) {
    if (!c || (!c.name && !c.phone && !c.email)) continue;
    const cp = normPhone(c.phone);
    const ce = normEmail(c.email);
    let match = null;
    if (cp || ce) {
      match = doc.contacts.find((ec) =>
        (cp && normPhone(ec.phone) === cp) || (ce && normEmail(ec.email) === ce));
    }
    if (match) {
      if (c.name && !match.name) match.name = c.name;
      if (c.role && !match.role) match.role = c.role;
      if (c.phone && !match.phone) match.phone = c.phone;
      if (c.email && !match.email) match.email = c.email;
    } else {
      doc.contacts.push({ name: c.name || '', role: c.role || '', phone: c.phone || '', email: c.email || '' });
    }
  }

  // Log - single structured import line, de-duped by (kind + dedupKey).
  const existingLogKeys = new Set(doc.log.map((l) => `${l.kind} ${l.dedupKey || l.text}`));
  for (const ln of (mapped.logs || [])) {
    const k = `${ln.kind} ${ln.dedupKey || ln.text}`;
    if (!existingLogKeys.has(k)) {
      doc.log.push({ at: new Date(), text: ln.text, kind: ln.kind, dedupKey: ln.dedupKey || '' });
      existingLogKeys.add(k);
    }
  }
  return doc;
}

// THE CONTRACT (re-import must be SAFE - never destroy owner work). Delegates the
// field policy to the pure applyImportToDoc; here we only do the DB fetch/save.
// Pass { dryRun:true } to compute the outcome WITHOUT writing (powers preview).
// Returns { outcome: 'created'|'updated'|'skipped', reason }.
async function applyMappedRow(mapped, opts = {}) {
  const dryRun = !!opts.dryRun;
  if (mapped._skip || !mapped.companyKey) {
    return { outcome: 'skipped', reason: mapped._skipReason || 'no-company' };
  }
  const key = mapped.companyKey;

  let doc = await Client.findOne({ companyKey: key });
  const isNew = !doc;
  if (!doc) doc = new Client({ companyKey: key, matchKey: mapped.matchKey || '', source: mapped.provenance || 'field-tracker' });

  // Does this company already have ≥1 linked Order? If so it's a customer,
  // regardless of any status word in the CSV. The caller may pre-compute a Set of
  // order-bearing keys (opts.keysWithOrders) to avoid a per-row query; otherwise
  // we look it up. (mapped.hasOrderNumber covers an order carried ON the row.)
  let hasOrders = !!mapped.hasOrderNumber;
  if (!hasOrders) {
    if (opts.keysWithOrders) hasOrders = opts.keysWithOrders.has(key);
    else hasOrders = !!(await Order.findOne({ companyKey: key }).select('_id').lean());
  }

  applyImportToDoc(doc, mapped, isNew, { hasOrders });

  // If this company was archived by a prior REPLACE pull and now appears again in
  // the CSV, the owner is explicitly re-importing it — bring it back into the
  // working set. We only auto-unarchive 'replaced' records (never a deliberate
  // 'merged' / manual archive, which stay archived unless restored on purpose).
  if (!isNew && doc.archived && doc.archivedReason === 'replaced') {
    doc.archived = false;
    doc.archivedAt = null;
    doc.archivedReason = '';
  }

  if (!dryRun) await doc.save();
  return { outcome: isNew ? 'created' : 'updated', reason: null };
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
    const body = req.body || {};
    const dryRun = body.dryRun === true || body.dryRun === 'true';
    const mode = body.mode === 'replace' ? 'replace' : 'merge';

    const mappedRows = buildMappedRows(body);
    if (mappedRows == null) {
      return res.status(400).json({ message: 'Provide { rows: [...] } or { csv: "..." }' });
    }

    // Skip breakdown (computed identically for dry-run and live so preview == reality).
    const skip = { dead: 0, noCompany: 0 };
    for (const m of mappedRows) {
      if (m._skip) { if (m._skipReason === 'dead') skip.dead += 1; else skip.noCompany += 1; }
    }

    // Existing records sharing an incoming matchKey -> merge proposals.
    const matchKeys = [...new Set(mappedRows.filter((m) => !m._skip && m.matchKey).map((m) => m.matchKey))];
    const existingByMatch = new Map();
    if (matchKeys.length) {
      const ex = await Client.find({ matchKey: { $in: matchKeys }, ...NOT_ARCHIVED })
        .select('companyKey companyName matchKey').lean();
      for (const e of ex) {
        const arr = existingByMatch.get(e.matchKey) || [];
        arr.push(e); existingByMatch.set(e.matchKey, arr);
      }
    }
    const proposedMerges = proposeImportMerges(mappedRows, existingByMatch);

    // Ambiguous/unparseable dates surfaced (never silently nulled).
    const ambiguousDates = [];
    for (const m of mappedRows) {
      for (const a of (m.ambiguousDates || [])) ambiguousDates.push({ company: m.companyName || m.companyKey, note: a });
    }

    if (dryRun) {
      const keepers = mappedRows.filter((m) => !m._skip && m.companyKey);
      const incomingKeys = [...new Set(keepers.map((m) => m.companyKey))];
      const existing = incomingKeys.length
        ? new Set((await Client.find({ companyKey: { $in: incomingKeys } }).select('companyKey').lean()).map((d) => d.companyKey))
        : new Set();
      let willCreate = 0, willUpdate = 0;
      const seen = new Set();
      for (const m of keepers) {
        if (existing.has(m.companyKey) || seen.has(m.companyKey)) willUpdate += 1; else willCreate += 1;
        seen.add(m.companyKey);
      }
      const willReplaceArchive = mode === 'replace' ? await countReplaceable() : 0;
      return res.json({
        dryRun: true, mode, total: mappedRows.length,
        willCreate, willUpdate, willSkip: skip, willReplaceArchive,
        proposedMerges, ambiguousDates,
      });
    }

    // -- Live import --
    const replacedArchived = mode === 'replace' ? await archiveReplaceable() : 0;

    // Pre-compute which incoming companies already have ≥1 Order, in ONE query,
    // so the per-row order→customer promotion doesn't fan out into N lookups.
    const keeperKeys = [...new Set(mappedRows.filter((m) => !m._skip && m.companyKey).map((m) => m.companyKey))];
    const keysWithOrdersSet = await keysWithOrders(keeperKeys);

    let created = 0, updated = 0;
    for (const mapped of mappedRows) {
      if (mapped._skip) continue; // already tallied in `skip`
      try {
        const { outcome } = await applyMappedRow(mapped, { keysWithOrders: keysWithOrdersSet });
        if (outcome === 'created') created++;
        else if (outcome === 'updated') updated++;
      } catch (rowErr) {
        skip.noCompany += 1; // count a failed row as a skip rather than aborting the run
      }
    }

    res.json({
      created, updated,
      skipped: skip, skippedTotal: skip.dead + skip.noCompany,
      replacedArchived, proposedMerges, ambiguousDates,
      total: mappedRows.length,
    });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// Provenance values written by the importer (Client.source) — the "pure import"
// origins replace-mode may sweep. Owner-created ('manual') and order-bootstrapped
// ('order') records are never in this set.
const IMPORT_SOURCES = ['field-tracker', 'notion', 'crm-sheet', 'import'];

// Tags the IMPORTER generates from a row's status/engagement (not owner work).
// ownerTouched ignores these so a freshly-imported, never-edited record stays
// "replaceable" even though the import tagged it 'cold'/'warm'/etc.
const IMPORT_TAGS = new Set([
  'hot', 'warm', 'room-temp', 'cold', 'lost', 'won', 'in-progress', 'meta-ad',
  'eng-high', 'eng-medium', 'eng-low', 'eng-inactive',
]);

// A "replaceable" record (mode:'replace') is a PURE prior import: from an import
// source, with NO Orders and no sign of owner editing. We soft-archive these
// before a fresh pull so re-import gives a clean slate without losing anything
// that has real activity. NOTHING is hard-deleted.
function ownerTouched(doc) {
  if (doc.stage && !['lead', 'contacted'].includes(doc.stage)) return true; // advanced past import defaults
  if (Number(doc.dealValue) > 0) return true;
  // Owner-added tags count as a touch; import-generated temperature/engagement
  // tags do NOT (otherwise every tagged import would look "edited" and never be
  // replaceable).
  if ((doc.tags || []).some((t) => !IMPORT_TAGS.has(String(t).toLowerCase()))) return true;
  if ((doc.notes || '').trim()) return true;
  for (const l of (doc.log || [])) {
    if (['call', 'text', 'email', 'visit'].includes(l.kind)) return true;   // a real human touch
  }
  return false;
}

async function keysWithOrders(keys) {
  if (!keys.length) return new Set();
  const rows = await Order.find({ companyKey: { $in: keys } }).select('companyKey').lean();
  return new Set(rows.map((r) => r.companyKey));
}

async function findReplaceable() {
  const candidates = await Client.find({ source: { $in: IMPORT_SOURCES }, ...NOT_ARCHIVED })
    .select('companyKey stage dealValue tags notes log source').lean();
  const withOrders = await keysWithOrders(candidates.map((c) => c.companyKey));
  return candidates.filter((c) => !withOrders.has(c.companyKey) && !ownerTouched(c));
}

async function countReplaceable() { return (await findReplaceable()).length; }

async function archiveReplaceable() {
  const repl = await findReplaceable();
  if (!repl.length) return 0;
  const keys = repl.map((c) => c.companyKey);
  await Client.updateMany(
    { companyKey: { $in: keys } },
    { $set: { archived: true, archivedAt: new Date(), archivedReason: 'replaced' } },
  );
  return keys.length;
}

// Accept rows keyed by the owner's headers OR by canonical names; produce a
// canonical-keyed object that mapTrackerRow understands. This is the JSON-rows
// path ({ rows: [{...}] }); the raw-CSV path goes through fieldTrackerImport's
// own header detection. We REUSE that module's single alias table (via
// canonHeader) so the two paths recognize EXACTLY the same set of headers
// (Notion / Google sheet / field tracker) with the same case/space/punctuation
// insensitivity — no second table to drift.
function normalizeRowKeys(row) {
  if (!row || typeof row !== 'object') return {};
  const out = {};
  for (const k of Object.keys(row)) {
    const canon = canonHeader(k);            // shared normHeader + alias lookup
    if (canon && !(canon in out)) out[canon] = row[k];
  }
  return out;
}

// Parse the import request body into an array of mapped rows. Returns null for a
// bad body shape (handled by the caller). Default year = current (UTC) year so
// bare M/D dates land in the right year, aligned with how /today compares them.
function buildMappedRows(body) {
  const year = Number(body && body.year) || new Date().getUTCFullYear();
  if (body && typeof body.csv === 'string' && body.csv.trim()) {
    // Raw CSV: detect the source format from its headers (field tracker / Notion
    // / Google sheet) and label the import line accordingly. Mapping is identical
    // across formats — detection only affects the human-readable source label.
    const { rows: objs, format } = rowsToObjectsWithMeta(parseCsv(body.csv));
    const sourceLabel = formatLabel(format);
    return objs.map((o) => mapTrackerRow(o, { year, format, sourceLabel }));
  }
  let rows = [];
  if (Array.isArray(body)) rows = body;
  else if (body && Array.isArray(body.rows)) rows = body.rows;
  else return null;
  // Detect the format from the JSON rows' header KEYS (not just canonical
  // columns), so a Notion / Google-sheet JSON payload gets the same keep-cold/lost
  // treatment as its CSV equivalent — and so a programmatic { rows } import isn't
  // wrongly dead-skipped. Sample the union of keys across the batch's first rows.
  const rawKeyCells = [];
  for (const r of rows.slice(0, 25)) {
    if (r && typeof r === 'object') for (const k of Object.keys(r)) rawKeyCells.push(k);
  }
  const cols = {};
  for (const k of rawKeyCells) { const c = canonHeader(k); if (c && !(c in cols)) cols[c] = true; }
  const format = detectFormat(cols, rawKeyCells);
  const sourceLabel = formatLabel(format);
  return rows.map((r) => mapTrackerRow(normalizeRowKeys(r), { year, format, sourceLabel }));
}

// Propose merges from an import batch: rows whose fuzzy matchKey collides but
// whose identity (companyKey) differs, folded together with any existing DB
// records sharing that matchKey, so the owner sees "these look like the same
// company" BEFORE committing. Suggestions only.
function proposeImportMerges(mappedRows, existingByMatch) {
  const byMatch = new Map();
  for (const m of mappedRows) {
    if (m._skip || !m.matchKey) continue;
    const g = byMatch.get(m.matchKey) || new Map();
    g.set(m.companyKey, m.companyName || m.companyKey);
    byMatch.set(m.matchKey, g);
  }
  const proposed = [];
  for (const [mk, names] of byMatch) {
    for (const ex of (existingByMatch.get(mk) || [])) names.set(ex.companyKey, ex.companyName || ex.companyKey);
    if (names.size > 1) {
      proposed.push({ matchKey: mk, members: [...names].map(([companyKey, name]) => ({ companyKey, name })) });
    }
  }
  return proposed;
}

// ── Cleanup tooling ────────────────────────────────────────────────────────────
// The owner-facing fix for the EXISTING mess (no hand-deleting). Three surfaces:
//   GET  /duplicates           → groups of likely-duplicate Clients
//   POST /merge                → fold one record into another (re-points orders)
//   POST /archive              → soft-delete (incl. a dead/no-follow-up sweep)

// Pick the best "survivor" from a duplicate group: prefer the one with the most
// signal — has orders > furthest stage > most log entries > most contacts >
// oldest (createdAt). Returns the survivor's companyKey.
function pickSurvivor(group, keysWithOrdersSet) {
  const stageRank = (s) => Math.max(0, STAGES.indexOf(s));
  const score = (c) => [
    keysWithOrdersSet.has(c.companyKey) ? 1 : 0,
    stageRank(c.stage),
    (c.log || []).length,
    (c.contacts || []).length,
    Number(c.dealValue) || 0,
    -new Date(c.createdAt || 0).getTime() / 1e13, // older wins as a tiebreak
  ];
  let best = group[0];
  let bestScore = score(best);
  for (const c of group.slice(1)) {
    const sc = score(c);
    for (let i = 0; i < sc.length; i++) {
      if (sc[i] > bestScore[i]) { best = c; bestScore = sc; break; }
      if (sc[i] < bestScore[i]) break;
    }
  }
  return best.companyKey;
}

// GET /api/crm/duplicates — groups of likely-duplicate Clients.
// Groups NON-archived records by their fuzzy matchKey (corp-suffix/punct/
// apostrophe stripped). A group of 2+ distinct companyKeys is a candidate. Each
// group carries a suggested survivor (pickSurvivor) so the UI can pre-select.
// Also folds in import-vs-existing-order-stub pairs: those naturally share a
// matchKey once both exist, so the single matchKey grouping covers it.
async function getDuplicates(req, res) {
  try {
    const docs = await Client.find(NOT_ARCHIVED)
      .select('companyKey companyName clientName matchKey stage dealValue contacts log createdAt nextFollowUp lastContact source')
      .lean();

    // Backfill a matchKey on the fly for any legacy doc that never got one, so
    // pre-existing records (created before this field) still group.
    const groups = new Map();
    for (const d of docs) {
      const mk = d.matchKey || deriveMatchKey(d.companyName, d.clientName);
      if (!mk) continue;
      const arr = groups.get(mk) || [];
      arr.push(d);
      groups.set(mk, arr);
    }

    const dupGroups = [];
    const allKeys = [];
    for (const arr of groups.values()) {
      const distinct = [...new Map(arr.map((d) => [d.companyKey, d])).values()];
      if (distinct.length > 1) { dupGroups.push(distinct); distinct.forEach((d) => allKeys.push(d.companyKey)); }
    }
    const withOrders = await keysWithOrders(allKeys);

    const out = dupGroups.map((arr) => ({
      matchKey: arr[0].matchKey || deriveMatchKey(arr[0].companyName, arr[0].clientName),
      suggestedSurvivor: pickSurvivor(arr, withOrders),
      members: arr.map((d) => ({
        companyKey:   d.companyKey,
        name:         d.companyName || d.clientName || d.companyKey,
        stage:        d.stage,
        dealValue:    Number(d.dealValue) || 0,
        contacts:     (d.contacts || []).length,
        logEntries:   (d.log || []).length,
        hasOrders:    withOrders.has(d.companyKey),
        nextFollowUp: d.nextFollowUp || null,
        lastContact:  d.lastContact || null,
        source:       d.source || '',
      })),
    }));
    // Most-actionable first: groups with an order-bearing member, then by size.
    out.sort((a, b) => (b.members.some((m) => m.hasOrders) ? 1 : 0) - (a.members.some((m) => m.hasOrders) ? 1 : 0)
      || b.members.length - a.members.length);

    res.json({ groups: out, total: out.length });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// Merge a duplicate-array of contacts, deduping by normalized phone/email.
function mergeContacts(into, extra) {
  const out = [...(into || [])];
  for (const c of (extra || [])) {
    if (!c || (!c.name && !c.phone && !c.email)) continue;
    const cp = normPhone(c.phone);
    const ce = normEmail(c.email);
    let match = null;
    if (cp || ce) match = out.find((ec) => (cp && normPhone(ec.phone) === cp) || (ce && normEmail(ec.email) === ce));
    if (match) {
      if (c.name && !match.name) match.name = c.name;
      if (c.role && !match.role) match.role = c.role;
      if (c.phone && !match.phone) match.phone = c.phone;
      if (c.email && !match.email) match.email = c.email;
    } else {
      out.push({ name: c.name || '', role: c.role || '', phone: c.phone || '', email: c.email || '' });
    }
  }
  return out;
}

// Pure survivor-folding policy for a merge: mutate `survivor` in place, pulling
// everything worth keeping out of `merged` WITHOUT losing data. No DB here so
// the fold rules are unit-testable. Order re-pointing + soft-delete stay in the
// async handler.
function foldMergeFields(survivor, merged, mergedKey) {
  if (!Array.isArray(survivor.tags)) survivor.tags = survivor.tags || [];
  if (!Array.isArray(survivor.log)) survivor.log = survivor.log || [];
  // Scalars: fill the survivor's blanks from the merged record (never clobber).
  for (const f of ['companyName', 'clientName', 'email', 'phone', 'paymentTerms',
    'defaultPrinter', 'defaultSupplier', 'area', 'interestType', 'lostReason']) {
    if (!survivor[f] && merged[f]) survivor[f] = merged[f];
  }
  if (!survivor.matchKey) survivor.matchKey = merged.matchKey || deriveMatchKey(survivor.companyName, survivor.clientName);
  if (!(Number(survivor.defaultMarkup) > 0) && Number(merged.defaultMarkup) > 0) survivor.defaultMarkup = merged.defaultMarkup;

  // Money: keep the LARGER open deal value (don't sum - avoids double-count).
  survivor.dealValue = Math.max(Number(survivor.dealValue) || 0, Number(merged.dealValue) || 0);
  // Stage: keep whichever is further along the funnel (don't regress).
  if (STAGES.indexOf(merged.stage) > STAGES.indexOf(survivor.stage)) survivor.stage = merged.stage;
  // Dates: lastContact = newer; nextFollowUp = keep survivor's, else inherit.
  if (merged.lastContact && (!survivor.lastContact || merged.lastContact > survivor.lastContact)) survivor.lastContact = merged.lastContact;
  if (!survivor.nextFollowUp && merged.nextFollowUp) survivor.nextFollowUp = merged.nextFollowUp;
  // Notes: concatenate (keep both).
  if ((merged.notes || '').trim()) {
    survivor.notes = [survivor.notes, merged.notes].filter((x) => (x || '').trim()).join('\n---\n');
  }
  // Tags: union (case-insensitive).
  const tagSeen = new Set(survivor.tags.map((t) => t.toLowerCase()));
  for (const t of (merged.tags || [])) { if (t && !tagSeen.has(t.toLowerCase())) { survivor.tags.push(t); tagSeen.add(t.toLowerCase()); } }
  // Contacts: merge with phone/email dedup.
  survivor.contacts = mergeContacts(survivor.contacts, merged.contacts);
  // Log: concat both, sort by time, then add a merge breadcrumb.
  survivor.log = [...(survivor.log || []), ...(merged.log || [])]
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));
  survivor.log.push({ at: new Date(), kind: 'note', text: `Merged in "${merged.companyName || mergedKey}" (${mergedKey})`, dedupKey: `merge:${mergedKey}` });
  return survivor;
}

// POST /api/crm/merge { survivorKey, mergedKey }
// Fold the merged record's contacts/log/dealValue/notes/tags into the survivor,
// RE-POINT the merged company's Orders (by companyKey) to the survivor, then
// soft-delete (archive) the merged record. Preserves ALL data — never loses an
// order or a history line; the merged record is recoverable.
async function mergeCompanies(req, res) {
  try {
    const survivorKey = String((req.body && req.body.survivorKey) || '').trim();
    const mergedKey   = String((req.body && req.body.mergedKey) || '').trim();
    if (!survivorKey || !mergedKey) return res.status(400).json({ message: 'survivorKey and mergedKey are required' });
    if (survivorKey === mergedKey)   return res.status(400).json({ message: 'survivorKey and mergedKey must differ' });

    const survivor = await Client.findOne({ companyKey: survivorKey });
    const merged   = await Client.findOne({ companyKey: mergedKey });
    if (!survivor) return res.status(404).json({ message: `survivor "${survivorKey}" not found` });
    if (!merged)   return res.status(404).json({ message: `merged "${mergedKey}" not found` });

    foldMergeFields(survivor, merged, mergedKey);

    await survivor.save();

    // RE-POINT the merged company's Orders to the survivor. Update both the key
    // and the display names so future deriveCompanyKey saves stay consistent.
    const orderUpdate = await Order.updateMany(
      { companyKey: mergedKey },
      { $set: { companyKey: survivorKey, companyName: survivor.companyName || '', clientName: survivor.clientName || '' } },
    );

    // Soft-delete the merged record (recoverable; nothing hard-deleted).
    merged.archived = true;
    merged.archivedAt = new Date();
    merged.archivedReason = 'merged';
    merged.mergedInto = survivorKey;
    await merged.save();

    const survivorLean = survivor.toObject();
    res.json({
      ok: true,
      survivor: survivorLean,
      ordersRepointed: orderUpdate.modifiedCount != null ? orderUpdate.modifiedCount : (orderUpdate.nModified || 0),
      mergedKey,
    });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/crm/archive
//   { keys: ["k1","k2"] }   → archive exactly these records, OR
//   { deadNoFollowUp: true } → convenience sweep: archive every NON-archived
//                              record that is dead/closed (lost/dormant) OR has
//                              no next follow-up AND no orders AND no owner edits.
// Soft-delete only — fully recoverable. Returns the count archived.
async function archiveCompanies(req, res) {
  try {
    const body = req.body || {};
    const force = body.force === true || body.force === 'true';
    let keys = [];
    let reason = body.reason || 'manual';

    if (Array.isArray(body.keys) && body.keys.length) {
      const requested = body.keys.map((k) => String(k || '').trim()).filter(Boolean);
      // SAFETY: by default never archive an order-bearing company out of the
      // working set, even if the UI surfaced it (e.g. a 'won' customer with no
      // next follow-up). Orders mean real history worth keeping visible. The
      // owner can override with { force: true } for a deliberate archive.
      if (force) {
        keys = requested;
      } else {
        const withOrders = await keysWithOrders(requested);
        keys = requested.filter((k) => !withOrders.has(k));
        if (keys.length < requested.length) {
          const skippedWithOrders = requested.filter((k) => withOrders.has(k));
          if (!keys.length) {
            return res.json({ ok: true, archived: 0, keys: [], skippedWithOrders });
          }
          // fall through; report the skipped ones alongside the archived count
          res.locals = res.locals || {};
          res.locals.skippedWithOrders = skippedWithOrders;
        }
      }
    } else if (body.deadNoFollowUp === true || body.deadNoFollowUp === 'true') {
      reason = 'dead-cleanup';
      // Sweep candidates: non-archived, no future follow-up OR a closed stage.
      const candidates = await Client.find({
        ...NOT_ARCHIVED,
        $or: [{ nextFollowUp: null }, { stage: { $in: CLOSED_STAGES } }],
      }).select('companyKey stage dealValue tags notes log nextFollowUp').lean();
      const keyList = candidates.map((c) => c.companyKey);
      const withOrders = await keysWithOrders(keyList);
      // Never sweep a record with orders or clear owner activity (safety).
      keys = candidates
        .filter((c) => !withOrders.has(c.companyKey) && !ownerTouched(c))
        .map((c) => c.companyKey);
    } else {
      return res.status(400).json({ message: 'Provide { keys: [...] } or { deadNoFollowUp: true }' });
    }

    if (!keys.length) return res.json({ ok: true, archived: 0, keys: [] });
    const result = await Client.updateMany(
      { companyKey: { $in: keys }, ...NOT_ARCHIVED },
      { $set: { archived: true, archivedAt: new Date(), archivedReason: reason } },
    );
    res.json({
      ok: true,
      archived: result.modifiedCount != null ? result.modifiedCount : (result.nModified || 0),
      keys,
      skippedWithOrders: (res.locals && res.locals.skippedWithOrders) || [],
    });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/crm/unarchive { keys: [...] } — restore soft-deleted records (the
// undo for archive/merge). For merged records, the orders stay on the survivor
// (re-pointing is a separate, deliberate act) — this just brings the record back
// into the working set.
async function unarchiveCompanies(req, res) {
  try {
    const keys = (Array.isArray(req.body && req.body.keys) ? req.body.keys : [])
      .map((k) => String(k || '').trim()).filter(Boolean);
    if (!keys.length) return res.status(400).json({ message: 'Provide { keys: [...] }' });
    const result = await Client.updateMany(
      { companyKey: { $in: keys } },
      { $set: { archived: false, archivedAt: null, archivedReason: '', mergedInto: '' } },
    );
    res.json({ ok: true, restored: result.modifiedCount != null ? result.modifiedCount : (result.nModified || 0), keys });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// ── Single-card actions (detail page) ──────────────────────────────────────────

// Decide which log entries survive deleting the one identified by `entryId`.
// Pure (no DB) so it's unit-testable. `entryId` matches an entry's _id (stringy)
// OR, for legacy entries written before log entries had ids, a numeric INDEX
// (delete-by-index fallback so nothing is stranded). Returns
// { next, removed } — the kept array and how many were removed (0 or 1).
function removeLogEntry(log, entryId) {
  const arr = Array.isArray(log) ? log : [];
  const id = String(entryId == null ? '' : entryId);
  if (!id) return { next: arr, removed: 0 };

  // Prefer an id match (stable handle).
  let idx = arr.findIndex((e) => e && e._id != null && String(e._id) === id);
  // Fallback: a pure-integer id is treated as an array index for legacy entries.
  if (idx < 0 && /^\d+$/.test(id)) {
    const n = Number(id);
    if (n >= 0 && n < arr.length) idx = n;
  }
  if (idx < 0) return { next: arr, removed: 0 };
  const next = arr.slice(0, idx).concat(arr.slice(idx + 1));
  return { next, removed: 1 };
}

// DELETE /api/crm/:companyKey/log/:entryId — remove ONE log entry from a card.
// Targets the entry by its _id; falls back to a numeric array index for legacy
// entries that predate stable ids. Returns the updated client.
async function deleteLogEntry(req, res) {
  try {
    const key = req.params.companyKey;
    const entryId = req.params.entryId;
    if (!key) return res.status(400).json({ message: 'companyKey required' });
    const doc = await Client.findOne({ companyKey: key });
    if (!doc) return res.status(404).json({ message: 'No CRM record for that key.' });

    const { next, removed } = removeLogEntry(doc.log, entryId);
    if (!removed) return res.status(404).json({ message: 'Log entry not found.' });
    doc.log = next;
    await doc.save();
    res.json({ ok: true, removed, client: doc.toObject() });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/crm/:companyKey/archive — soft-archive THIS one card (owner: "fine
// removing their card"). NEVER hard-deletes; the record + its order links + log
// are fully preserved and restorable. Archived cards drop out of every working
// surface (today/dashboard/pipeline/calendar/list) via the NOT_ARCHIVED filter.
// Unlike the bulk /archive, this is an explicit single-card act, so it archives
// even an order-bearing company (the owner deliberately chose this card) and
// records the reason.
async function archiveOne(req, res) {
  try {
    const key = req.params.companyKey;
    if (!key) return res.status(400).json({ message: 'companyKey required' });
    const reason = (req.body && req.body.reason) || 'manual';
    const doc = await Client.findOneAndUpdate(
      { companyKey: key },
      { $set: { archived: true, archivedAt: new Date(), archivedReason: reason } },
      { new: true },
    ).lean();
    if (!doc) return res.status(404).json({ message: 'No CRM record for that key.' });
    res.json({ ok: true, archived: 1, client: doc });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/crm/:companyKey/unarchive — restore THIS one card (the undo).
async function unarchiveOne(req, res) {
  try {
    const key = req.params.companyKey;
    if (!key) return res.status(400).json({ message: 'companyKey required' });
    const doc = await Client.findOneAndUpdate(
      { companyKey: key },
      { $set: { archived: false, archivedAt: null, archivedReason: '', mergedInto: '' } },
      { new: true },
    ).lean();
    if (!doc) return res.status(404).json({ message: 'No CRM record for that key.' });
    res.json({ ok: true, restored: 1, client: doc });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
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
  getDuplicates,
  mergeCompanies,
  archiveCompanies,
  unarchiveCompanies,
  deleteLogEntry,
  archiveOne,
  unarchiveOne,
  // exported for tests / reuse
  applyMappedRow,
  applyImportToDoc,
  normalizeRowKeys,
  buildMappedRows,
  proposeImportMerges,
  companyFinance,
  scopeCompanyTransactions,
  foldMergeFields,
  pickSurvivor,
  mergeContacts,
  ownerTouched,
  summarizePipeline,
  stageProbability,
  STAGE_PROBABILITY,
  classifyHeadsUp,
  buildHeadsUp,
  HEADS_UP,
  promoteStage,
  removeLogEntry,
  searchOr,
};
