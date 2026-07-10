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
const OutreachCampaign = require('../models/OutreachCampaign');
const OutreachEnrollment = require('../models/OutreachEnrollment');
// REUSE canonical key normalization + the single source of truth for which order
// statuses count as a REAL placed order (a customer). Never re-list these here.
const { deriveCompanyKey, PLACED_STATUSES } = require('../models/Order');
const PurchaseOrder = require('../models/PurchaseOrder');
const Transaction   = require('../models/Transaction');
// REUSE the finance definitions verbatim — the company money summary must match
// /api/finances exactly (same revenue/COGS/profit/margin math, same order-number
// normalization). Never re-derive finance numbers here.
const { summarizeCompanyFinance, normalizeOrderNumber } = require('./finances');
const { scoreLead } = require('../services/leadScore');
const {
  parseCsv, rowsToObjects, rowsToObjectsWithMeta, mapTrackerRow,
  matchKey: deriveMatchKey, matchKeysFuzzyEqual, normPhone, normEmail,
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
  lead: 0, contacted: 1, awaiting_details: 2, quoting: 3, won: 5, customer: 5,
};
// Pre-customer stages — a won/customer or order-bearing company must never be
// regressed INTO one of these through an ordinary edit (customer permanence).
const PRE_CUSTOMER_STAGES = new Set(['lead', 'contacted', 'awaiting_details', 'quoting']);
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

// The stages a promote-only SUGGESTION (patchOne's `stageSuggest`, used by the
// Field Map's visit/to-do capture) may move a record FROM, for a given target:
// exactly the stages ranked strictly below it. lost/dormant carry no rank, so
// they are never promotable-from (owner-closed stays closed) and — as targets —
// yield an empty list (never promoted into). Pure + exported for tests; the
// caller turns this into an ATOMIC conditional update (the filter re-checks
// the rule at write time), so a concurrent owner edit between an offline
// queue's read and its replayed write can never be overwritten.
function promotableFrom(target) {
  const tr = STAGE_RANK[target] != null ? STAGE_RANK[target] : 0;
  return Object.keys(STAGE_RANK).filter((s) => STAGE_RANK[s] < tr);
}

// Auto-promote a company's CRM record to 'customer' when one of its orders has
// been PLACED (owner-approved). Best-effort and idempotent:
//   • get-or-create the Client by companyKey (race-safe upsert; seeds identity
//     from the order on insert),
//   • move stage via promoteStage(stage,'customer') — UP-only, and NEVER touches
//     won/lost/dormant, so a closed/parked deal is never resurrected or regressed.
// Returns the resulting stage (or null on no-op). The CALLER wraps this in
// try/catch — an order write must never fail because of a CRM hiccup — but we
// also keep this self-contained and side-effect-light. `sample` carries the
// order's companyName/clientName so a brand-new record gets a real name.
async function promoteCompanyToCustomerOnPlacement(companyKey, sample = {}) {
  const key = (companyKey || '').trim();
  if (!key) return null;
  const companyName = sample.companyName || '';
  const clientName  = sample.clientName  || '';
  // Race-safe get-or-create: upsert on the unique companyKey (mirrors getOne) so
  // two concurrent placements can't both insert. $setOnInsert only writes on a
  // genuine insert; an existing record keeps its fields (incl. an owner-set name).
  const doc = await Client.findOneAndUpdate(
    { companyKey: key },
    {
      $setOnInsert: {
        companyKey:  key,
        companyName,
        clientName,
        matchKey:    deriveMatchKey(companyName, clientName),
        source:      'order',
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  if (!doc) return null;
  const next = promoteStage(doc.stage, 'customer');
  if (next !== doc.stage) {
    doc.stage = next;
    await doc.save();
  }
  return next;
}

// Ensure a CRM Client record exists for a company that just entered QUOTING (the
// lead→quote handoff mints an Order; this guarantees the company is also a
// first-class CRM citizen so it shows on the order-centric board, in Companies,
// Today, etc.). Best-effort + idempotent, mirroring promoteCompanyToCustomerOn-
// Placement:
//   • race-safe get-or-create by the unique companyKey ($setOnInsert seeds
//     identity + a 'quoting' stage on a genuine insert only),
//   • for an EXISTING record, nudge the stage UP to 'quoting' via promoteStage —
//     which never regresses an owner-advanced stage and never touches won/lost/
//     dormant/customer. So a brand-new company lands at 'quoting'; a lead/contacted
//     record advances to 'quoting'; a won/customer/closed record is left
//     exactly as the owner set it.
// Returns the resulting stage (or null on no-op). The CALLER wraps this in
// try/catch — an order write must never fail because of a CRM hiccup. `sample`
// carries the order's companyName/clientName/dealValue to seed a new record.
async function ensureCompanyForQuoting(companyKey, sample = {}) {
  const key = (companyKey || '').trim();
  if (!key) return null;
  const companyName = sample.companyName || '';
  const clientName  = sample.clientName  || '';
  const dealValue   = Number(sample.dealValue) || 0;
  const doc = await Client.findOneAndUpdate(
    { companyKey: key },
    {
      $setOnInsert: {
        companyKey:  key,
        companyName,
        clientName,
        matchKey:    deriveMatchKey(companyName, clientName),
        source:      'order',
        stage:       'quoting',
        ...(dealValue > 0 ? { dealValue } : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  if (!doc) return null;
  const next = promoteStage(doc.stage, 'quoting');
  if (next !== doc.stage) {
    doc.stage = next;
    await doc.save();
  }
  return next;
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
  lead:             0.1,
  contacted:        0.25,
  awaiting_details: 0.35,
  quoting:          0.5,
  won:              1,
  customer:         1,
  lost:             0,
  dormant:          0,
};
const stageProbability = (stage) => (
  Object.prototype.hasOwnProperty.call(STAGE_PROBABILITY, stage) ? STAGE_PROBABILITY[stage] : 0
);

// Stages whose deals are still IN FLIGHT — money in play but not yet realized.
// These are the only stages that count toward "open pipeline" value. won &
// customer are closed-won (revenue realized, not open); lost & dormant are dead.
// (Distinct from the call-engine's CLOSED_STAGES, which keeps `customer` callable
// for retention — that's about who to call, not open deal value.)
const OPEN_STAGES = ['lead', 'contacted', 'awaiting_details', 'quoting'];

// Compute the board summary from a flat list of { stage, dealValue } records.
// Pure (no DB) so it's unit-testable. Returns:
//   { totalOpenValue, weightedValue }
// - totalOpenValue: sum of dealValue across OPEN stages only.
// - weightedValue:  sum of dealValue × stageProbability across ALL stages.
function summarizePipeline(records) {
  let totalOpenValue = 0;
  let weightedValue = 0;
  let weightedOpenValue = 0;
  for (const r of records || []) {
    const val = Number(r && r.dealValue) || 0;
    const stage = r && r.stage;
    if (OPEN_STAGES.includes(stage)) {
      totalOpenValue += val;
      weightedOpenValue += val * stageProbability(stage); // forecast of the OPEN pipe only
    }
    weightedValue += val * stageProbability(stage);
  }
  return {
    totalOpenValue:    Math.round(totalOpenValue * 100) / 100,
    weightedValue:     Math.round(weightedValue * 100) / 100,
    // Expected value of the OPEN pipeline (open dealValue × its own stage odds). This
    // is the correct numerator for "% likely to land": dividing it by totalOpenValue
    // shares the SAME open-stage set, so the ratio is inherently ≤ 100%. (weightedValue
    // divided by totalOpenValue was the bug — it mixed realized won/customer revenue,
    // prob 1, into the numerator while the denominator counted only open stages → 460%.)
    weightedOpenValue: Math.round(weightedOpenValue * 100) / 100,
  };
}

// ── Unified order-centric board ─────────────────────────────────────────────────
// The pipeline board is "one client → many orders": a brand-new lead is one
// pre-quote card sourced from its Client record; once a company is quoting+, each
// of its Orders is its OWN card flowing across the fulfillment columns. So a
// company with 3 live orders shows 3 cards, and a never-quoted prospect shows 1.
//
// COLUMNS (left → right), then a collapsed closed/parked lane:
//   lead, contacted          ← Client cards (pre-quote stages) with NO live order
//   quoting                  ← Order status 'quoted'
//   approval                 ← Order status 'approved'
//   production               ← Order status 'placed' OR 'in_production'
//   shipped                  ← Order status 'shipped'
//   delivered                ← Order status 'delivered'  (won; capped to recent)
//   ── closed / parked ──
//   lost, dormant            ← Client cards (deliberately-closed stages)
//   cancelled                ← Order status 'cancelled'
//
// Lead columns reuse the existing Client CRM early stages so the lost/dormant
// closed cards and the lead/contacted pre-quote cards still come from the one
// Client-per-companyKey record (company dedup intact) — the multiplicity is only
// in the order columns, and it's intentional (distinct jobs).
const BOARD_COLUMNS = [
  'lead', 'contacted', 'awaiting_details',
  'quoting', 'approval', 'production', 'shipped', 'delivered',
];
const BOARD_CLOSED_COLUMNS = ['lost', 'dormant', 'cancelled'];
const ALL_BOARD_COLUMNS = [...BOARD_COLUMNS, ...BOARD_CLOSED_COLUMNS];

// The Client pre-quote stages that seed the LEAD columns. Only a company with no
// live order earns a lead card (else it already shows as an order card). Mid-
// funnel Client stages (quoting) are intentionally absent — once a deal
// is quoting it lives in the ORDER columns, sourced from its Order rows.
const BOARD_LEAD_STAGES = ['lead', 'contacted', 'awaiting_details'];
// Client mid-funnel stages that, WITHOUT a live order, fall back to a card in the
// QUOTING column — so a deal advanced to quoting never vanishes from the
// board in the window before its order row exists (or if the order mint failed).
// Once the company has a live order, its order card represents it and this
// fallback is suppressed.
const BOARD_QUOTING_FALLBACK_STAGES = ['quoting'];
// The Client closed/parked stages that seed the closed lane (alongside cancelled
// orders). These mirror the old SECONDARY_STAGES.
const BOARD_CLOSED_CLIENT_STAGES = ['lost', 'dormant'];

// Board columns whose value is still "open" (in play, not realized/dead). Lead
// columns + the pre-delivery order columns. delivered is won (realized, not
// open); lost/dormant/cancelled are dead. Keeps the header band's "open pipeline"
// honest over the unified set.
const BOARD_OPEN_COLUMNS = ['lead', 'contacted', 'awaiting_details', 'quoting', 'approval', 'production', 'shipped'];

// Close-probability per BOARD column — drives the weighted forecast over the
// unified set. Lead columns keep the Client STAGE_PROBABILITY so a lead's
// forecast is unchanged; the order columns climb toward realization. delivered is
// realized (1); the closed lane carries no forecast (0). Exposed on the payload
// so the board can label without hardcoding.
const BOARD_PROBABILITY = {
  lead:             0.1,
  contacted:        0.25,
  awaiting_details: 0.35,
  quoting:          0.5,
  approval:   0.8,
  production: 0.9,
  shipped:    0.95,
  delivered:  1,
  lost:       0,
  dormant:    0,
  cancelled:  0,
};
const boardProbability = (col) => (
  Object.prototype.hasOwnProperty.call(BOARD_PROBABILITY, col) ? BOARD_PROBABILITY[col] : 0
);

// Cap the Delivered/Won column to the most-recent N orders so it can't grow
// unbounded as history piles up (the board is a working surface, not an archive).
const DELIVERED_CAP = 25;

// Map an Order.status → its board column. PURE + unit-tested. Returns null for an
// unknown status so the caller can drop it rather than mis-bucket it. 'placed' and
// 'in_production' both land in 'production' (one fulfillment column, kept lean).
function orderStatusToColumn(status) {
  switch (status) {
    case 'quoted':        return 'quoting';
    case 'approved':      return 'approval';
    case 'placed':        return 'production';
    case 'in_production': return 'production';
    case 'shipped':       return 'shipped';
    case 'delivered':     return 'delivered';
    case 'cancelled':     return 'cancelled';
    default:              return null;
  }
}

// Stable per-order card key: prefer the human projectNumber, fall back to the
// mongo _id, so React never sees a duplicate key even when one company has many
// orders. Always prefixed 'order:' so it can't collide with a lead card's
// companyKey.
function orderCardKey(order) {
  const pn = order && order.projectNumber != null ? String(order.projectNumber).trim() : '';
  const id = order && order._id != null ? String(order._id) : '';
  return `order:${pn || id || Math.random().toString(36).slice(2)}`;
}

// An order is "live" (occupies a fulfillment column and suppresses its company's
// lead card) when it isn't archived and isn't cancelled. delivered still counts as
// live for lead-suppression — the company clearly got past the lead stage.
function isLiveOrderRow(o) {
  if (!o || o.archived) return false;
  return o.status !== 'cancelled';
}

// Assemble the unified board from lean Client + Order rows. PURE (no DB) so the
// whole feed shape is unit-testable. Inputs:
//   clients          — lean Client POJOs (companyKey, stage, dealValue, name…)
//   orders           — lean Order POJOs (companyKey, status, totalValue, archived,
//                      projectNumber, _id, companyName/clientName)
//   withPlacedOrders — Set<companyKey> that have ≥1 PLACED order (isCustomer)
//   dealValueByKey   — Map<companyKey, number> company dealValue (order $ fallback)
//   now              — Date (delivered-cap recency anchor; reserved, cap is by count)
//   deliveredCap     — keep only the most-recent N delivered cards (default DELIVERED_CAP)
// Returns { groups, summary, columns } where groups is one { stage, count,
// totalValue, clients[] } per board column (active then closed), in board order.
function buildUnifiedBoard({ clients, orders, withPlacedOrders, dealValueByKey, deliveredCap = DELIVERED_CAP } = {}) {
  const placed = withPlacedOrders instanceof Set ? withPlacedOrders : new Set(withPlacedOrders || []);
  const dealBy = dealValueByKey instanceof Map ? dealValueByKey : new Map(Object.entries(dealValueByKey || {}));

  // companyKeys that have a LIVE order (non-archived, non-cancelled). Their Client
  // record never contributes a lead card — the order card(s) represent them.
  const liveKeys = new Set();
  for (const o of orders || []) {
    if (isLiveOrderRow(o) && o.companyKey) liveKeys.add(o.companyKey);
  }

  // Seed every column so empty ones still render in canonical order.
  const byCol = {};
  for (const c of ALL_BOARD_COLUMNS) byCol[c] = { stage: c, count: 0, totalValue: 0, clients: [] };

  // ── Lead + closed-CLIENT cards ────────────────────────────────────────────────
  // Build a lead-style (Client) card; `col` is the board column it lands in.
  const leadCard = (c, col) => ({
    cardKey:      c.companyKey,
    cardKind:     'lead',
    companyKey:   c.companyKey,
    name:         (c.companyName || c.clientName || c.companyKey),
    dealValue:    Number(c.dealValue) || 0,
    nextFollowUp: c.nextFollowUp || null,
    stage:        col,
    address:      c.address || '',
    area:         c.area || '',
    interestType: c.interestType || '',
    tags:         c.tags || [],
    leadSource:   c.leadSource || '',
    isCustomer:   placed.has(c.companyKey),
  });
  for (const c of clients || []) {
    const stage = c && c.stage;
    if (BOARD_LEAD_STAGES.includes(stage)) {
      // Suppress the lead card if the company already has a live order — it shows
      // as an order card instead (no double-count, no leftover lead).
      if (liveKeys.has(c.companyKey)) continue;
      byCol[stage].clients.push(leadCard(c, stage)); // board column == the client stage
    } else if (BOARD_QUOTING_FALLBACK_STAGES.includes(stage)) {
      // A Client advanced to quoting but with NO order row yet (a freshly
      // moved deal whose order mint is still in flight, or one whose handoff hiccuped)
      // still shows a card in the QUOTING column so it never silently vanishes from
      // the board. The moment a live order exists it's suppressed here and rendered
      // as an order card instead.
      if (liveKeys.has(c.companyKey)) continue;
      byCol.quoting.clients.push(leadCard(c, 'quoting'));
    } else if (BOARD_CLOSED_CLIENT_STAGES.includes(stage)) {
      byCol[stage].clients.push(leadCard(c, stage));
    }
    // won/customer Client stages contribute NO lead card — those companies are
    // represented by their Order rows in the fulfillment columns.
  }

  // ── Order cards (one per order) ───────────────────────────────────────────────
  // Collect delivered separately so we can cap to the most recent before placing.
  const delivered = [];
  for (const o of orders || []) {
    if (o && o.archived) continue;            // archived orders never hit the board
    const col = orderStatusToColumn(o.status);
    if (!col) continue;                        // unknown status → drop
    const name = (o.companyName || o.clientName || o.companyKey || '');
    // Deal value: the order's own total, falling back to the company's CRM deal
    // value when the order has no total yet (a freshly-minted quote at $0).
    const own = Number(o.totalValue) || 0;
    const dealValue = own > 0 ? own : (Number(dealBy.get(o.companyKey)) || 0);
    const card = {
      cardKey:      orderCardKey(o),
      cardKind:     'order',
      _id:          o._id != null ? String(o._id) : '',
      companyKey:   o.companyKey || '',
      name,
      projectNumber: o.projectNumber != null ? String(o.projectNumber) : '',
      orderStatus:  o.status,
      dealValue,
      nextFollowUp: null,
      stage:        col,             // the board column this order sits in
      tags:         [],
      isCustomer:   placed.has(o.companyKey),
    };
    if (col === 'delivered') delivered.push({ card, o });
    else byCol[col].clients.push(card);
  }
  // Cap delivered to the most-recent N (by orderDate, then createdAt, then _id).
  delivered.sort((a, b) => orderRecency(b.o) - orderRecency(a.o));
  for (const { card } of delivered.slice(0, Math.max(0, deliveredCap))) {
    byCol.delivered.clients.push(card);
  }

  // Tally counts + totals per column over the FINAL card set (post-cap).
  for (const c of ALL_BOARD_COLUMNS) {
    const g = byCol[c];
    g.count = g.clients.length;
    g.totalValue = Math.round(g.clients.reduce((s, k) => s + (Number(k.dealValue) || 0), 0) * 100) / 100;
  }

  const groups = ALL_BOARD_COLUMNS.map((c) => byCol[c]);
  const summary = summarizeBoard(groups);
  return { groups, summary, columns: { active: BOARD_COLUMNS, closed: BOARD_CLOSED_COLUMNS } };
}

// Recency score for ordering/capping delivered orders. Higher = more recent.
function orderRecency(o) {
  const d = o && (o.orderDate || o.updatedAt || o.createdAt);
  const t = d ? new Date(d).getTime() : 0;
  return Number.isNaN(t) ? 0 : t;
}

// Board summary over the assembled column groups (or a flat card list). PURE +
// unit-tested. Mirrors summarizePipeline but board-column aware:
//   totalOpenValue — Σ dealValue across the OPEN board columns only.
//   weightedValue  — Σ dealValue × boardProbability across ALL columns.
// Accepts either groups ([{ stage, clients[] }]) or a flat array of cards.
function summarizeBoard(input) {
  const cards = [];
  for (const item of input || []) {
    if (item && Array.isArray(item.clients)) {
      for (const card of item.clients) cards.push({ stage: item.stage, dealValue: card.dealValue });
    } else if (item) {
      cards.push({ stage: item.stage, dealValue: item.dealValue });
    }
  }
  let totalOpenValue = 0;
  let weightedValue = 0;
  for (const c of cards) {
    const val = Number(c.dealValue) || 0;
    if (BOARD_OPEN_COLUMNS.includes(c.stage)) totalOpenValue += val;
    weightedValue += val * boardProbability(c.stage);
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

// An engine-managed COLD-OUTREACH prospect the owner hasn't personally engaged: the
// lead-finder / mail-merge produced it (tagged cold-email/dispensary/cold/meta-ad, or
// leadSource 'Cold Outreach'), it lives in the CRM only so the outreach engine can
// enroll & drip it, and it is NOT the owner's to work until it REPLIES (→ 'warm' tag)
// or the owner personally touches it (a call/text/visit log — an automated cold
// 'email' send doesn't count). Deliberately IGNORES nextFollowUp: the engine and the
// importer stamp follow-up dates on these leads, and an engine-stamped date is NOT an
// owner-scheduled action — treating one as such is exactly the "stepping on its own
// toes" bug where cold mail-merge leads surfaced as "call today". Pure. The cadence
// cockpit excludes exactly these, so its buckets stay the OWNER's chosen worklist — a
// genuine new lead (untagged) still flows through.
function isEngineManagedCold(c) {
  if (!c) return false;
  const stage = c.stage;
  const tags = (c.tags || []).map((t) => String(t).toLowerCase());
  const outreachProspect = !tags.includes('warm')
    && (tags.includes('cold-email') || tags.includes('dispensary') || tags.includes('cold')
      || tags.includes('meta-ad') || c.leadSource === 'Cold Outreach');
  const ownerTouched = (c.log || []).some((l) => ['call', 'text', 'visit'].includes(l && l.kind));
  return outreachProspect && !ownerTouched && stage !== 'customer' && stage !== 'won';
}

// The narrower "engine's job AND nothing scheduled" slice: engine-managed cold with no
// follow-up date at all. Used by classifyHeadsUp's dead-weight suppression, which only
// ever gates the no_next_step / stale flags — both of which already presuppose no
// scheduled step. The cadence cockpit uses the broader isEngineManagedCold above so an
// engine-stamped follow-up can't leak a cold lead back onto the owner's worklist. Pure.
function isOutreachPool(c) {
  return isEngineManagedCold(c) && c.nextFollowUp == null;
}

// The BROADER heads-up suppression: cold-outreach spam OR a sub-hot bare
// uncontacted 'lead' with nothing worked yet. Used by classifyHeadsUp to keep the
// low-signal no_next_step/stale flags from burying real work; a hot value or an
// explicit follow-up still surfaces the record via the overdue/hot_quiet checks.
// Pure.
function isColdDeadWeight(c) {
  if (!c) return false;
  const value = Number(c.dealValue) || 0;
  if (value >= HEADS_UP.HOT_VALUE) return false;
  const lc = c.lastContact ? new Date(c.lastContact).getTime() : null;
  const everContacted = lc != null || (c.log || []).some((l) => ['call', 'text', 'email', 'visit'].includes(l && l.kind));
  return isOutreachPool(c) || (c.stage === 'lead' && !everContacted);
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
  // Snoozed ("remind me later") — hard-hidden from the feed until the date passes,
  // even a hot deal. It returns on its own once snoozedUntil is in the past.
  if (c.snoozedUntil && new Date(c.snoozedUntil).getTime() > nowMs) return [];
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
  // NOT today's priority. isColdDeadWeight (shared with the cadence cockpit) is the
  // predicate; we SUPPRESS the low-signal no_next_step/stale flags for those (they'd
  // otherwise bury the real work). A real follow-up date or a hot value still
  // surfaces them via the overdue/hot_quiet checks below.
  const coldDeadWeight = isColdDeadWeight(c);

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

// ─────────────────────────────────────────────────────────────────────────────
// CADENCE COCKPIT — the owner's day, organized by the NEXT ACTION instead of by
// problem type. Where the heads-up feed answers "what's wrong?", the cockpit
// answers "what do I DO, and in what order?". Every active company lands in
// EXACTLY ONE bucket, first match wins in priority order:
//
//   your_move    — you owe the next move NOW: an overdue follow-up, or a hot
//                  deal you've gone quiet on. (Top of the day.)
//   call_today   — a follow-up you scheduled for today. Pick up the phone.
//   closing_soon — a live quote is out; nudge it over the line.
//   make_mockup  — an engaged early lead with nothing scheduled — move it
//                  forward by getting a mockup in front of them.
//   on_the_rails — a healthy deal with a future step already booked; nothing to
//                  do today, shown for reassurance.
//
// Closed deals (won/customer/lost/dormant), snoozed cards, and never-worked cold
// prospects (isColdDeadWeight) are excluded — the cockpit is the LIVE worklist.
// Pure + unit-tested; caps each bucket so the payload stays small.
const CADENCE_BUCKETS = ['your_move', 'call_today', 'closing_soon', 'make_mockup', 'on_the_rails'];
const CADENCE_BUCKET_SEVERITY = {
  your_move: 'high', call_today: 'high', closing_soon: 'med', make_mockup: 'med', on_the_rails: 'low',
};
const CADENCE_BUCKET_CAP = 40;

function cadenceEntry(c, bucket, message) {
  const name = c.companyName || c.clientName || c.companyKey;
  const phone = c.phone || ((c.contacts || []).find((x) => x && x.phone) || {}).phone || '';
  return {
    // `type` = bucket so the frontend can reuse the heads-up row (icon/color by
    // type) verbatim; `bucket` is the grouping key.
    type: bucket, bucket, severity: CADENCE_BUCKET_SEVERITY[bucket],
    companyKey: c.companyKey, name, phone,
    value: Number(c.dealValue) || 0, stage: c.stage,
    message, date: c.nextFollowUp || null,
  };
}

// Assign ONE client to its cadence bucket (or null if it's off the live worklist).
// nowMs / todayMs as in classifyHeadsUp. Pure + unit-tested.
function cadenceBucketFor(c, nowMs, todayMs) {
  if (!c) return null;
  if (c.snoozedUntil && new Date(c.snoozedUntil).getTime() > nowMs) return null;
  const stage = c.stage;
  if (CLOSED_STAGES.includes(stage)) return null; // won/customer/lost/dormant — not the worklist

  // Engine-managed cold-outreach prospects the owner never personally engaged are the
  // OUTREACH ENGINE's job, not the owner's — off the cockpit entirely, even if the
  // engine/importer stamped a follow-up date on them (that date is not an owner-chosen
  // action). They rejoin the worklist the moment they go warm (a reply adds the 'warm'
  // tag) or the owner works them (a call/text/visit log). Checked BEFORE your_move /
  // call_today so a stamped follow-up can't drag a cold lead onto the owner's day.
  if (isEngineManagedCold(c)) return null;

  const value = Number(c.dealValue) || 0;
  const lc = c.lastContact ? new Date(c.lastContact).getTime() : null;
  const followDayDiff = c.nextFollowUp != null ? dayDiffFromToday(c.nextFollowUp, new Date(nowMs)) : null;

  // 1) YOUR MOVE — an overdue follow-up (you scheduled it, it's past), or a hot
  //    deal gone quiet. Always wins, even for a cold lead the owner explicitly
  //    scheduled or that carries real money.
  if (followDayDiff != null && followDayDiff < 0) {
    const d = -followDayDiff;
    return cadenceEntry(c, 'your_move', `Follow-up ${d === 1 ? '1 day' : `${d} days`} overdue`);
  }
  if (value >= HEADS_UP.HOT_VALUE) {
    const quiet = lc != null ? daysBetween(lc, nowMs) : null;
    if (lc == null || quiet > HEADS_UP.QUIET_DAYS) {
      return cadenceEntry(c, 'your_move',
        lc == null ? `Hot deal (${fmtUsd(value)}) — never contacted` : `Hot deal (${fmtUsd(value)}) quiet ${quiet} days`);
    }
  }

  // 2) CALL TODAY — a follow-up you booked for today.
  if (followDayDiff === 0) return cadenceEntry(c, 'call_today', 'Follow-up due today');

  // 3) CLOSING SOON — a live quote is out; chase the close.
  if (stage === 'quoting') {
    return cadenceEntry(c, 'closing_soon', value > 0 ? `Quote out — ${fmtUsd(value)} on the table` : 'Quote out — follow up to close');
  }

  // 4) MAKE A MOCKUP — an engaged early lead with nothing scheduled: the natural
  //    next step is putting a mockup in front of them.
  if ((stage === 'lead' || stage === 'contacted') && c.nextFollowUp == null) {
    return cadenceEntry(c, 'make_mockup', 'Send a mockup to move it forward');
  }

  // 5) ON THE RAILS — a healthy deal with a future step booked. Nothing to do today.
  if (followDayDiff != null && followDayDiff > 0) {
    return cadenceEntry(c, 'on_the_rails', `Next step in ${followDayDiff} day${followDayDiff === 1 ? '' : 's'}`);
  }
  return null;
}

// Bucket a whole book of clients into the cockpit. Sorts each bucket by value
// (desc) then soonest date, caps it, and returns per-bucket counts (full, uncapped).
// Returns: { buckets: { <key>: [entry...] }, counts: { <key>: n }, total }.
function buildCockpit(clients, nowMs, todayMs) {
  const buckets = {};
  for (const b of CADENCE_BUCKETS) buckets[b] = [];
  for (const c of clients || []) {
    const e = cadenceBucketFor(c, nowMs, todayMs);
    if (e) buckets[e.bucket].push(e);
  }
  const counts = {};
  let total = 0;
  for (const b of CADENCE_BUCKETS) {
    buckets[b].sort((a, z) => {
      if (z.value !== a.value) return z.value - a.value;
      const ad = a.date ? new Date(a.date).getTime() : Infinity;
      const zd = z.date ? new Date(z.date).getTime() : Infinity;
      return ad - zd;
    });
    counts[b] = buckets[b].length;
    total += buckets[b].length;
    buckets[b] = buckets[b].slice(0, CADENCE_BUCKET_CAP);
  }
  return { buckets, counts, total };
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
    const { stage, area, q, tag, archived, leadSource } = req.query;
    // Default list EXCLUDES archived; ?archived=1 shows only archived, =all shows
    // everything (for an "Archived" tab / restore surface).
    const filter = {};
    if (archived === '1' || archived === 'true') filter.archived = true;
    else if (archived === 'all') { /* no archived constraint */ }
    else Object.assign(filter, NOT_ARCHIVED);

    // Structured lead-source filter (?leadSource=Referral). Applies in BOTH the
    // browse and the global-search path so "find X from referrals" works. Only a
    // recognized enum value constrains; anything else is ignored.
    if (leadSource && Client.LEAD_SOURCES.includes(leadSource)) filter.leadSource = leadSource;

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
    // Which of these companies have ≥1 PLACED order (⇒ customers)? The Companies
    // list's ★ / segment split / cleanup-candidate / demote-guard all read this
    // server-computed flag — the same one getToday/getPipeline/getOne attach —
    // so it MUST be here too, or a customer parked at 'dormant' mis-files under
    // "Everyone else" and can be offered for archive. One batched query.
    const withOrders = await keysWithOrders(clients.map((c) => c.companyKey));
    // Attach a lead-quality grade (A–D) to each row — how actionable the lead is
    // for cold email + road visits (see services/leadScore.js) — so the Companies
    // list can badge and sort by it and the owner works the best leads first.
    const scored = clients.map((c) => {
      const s = scoreLead(c);
      return { ...c, isCustomer: withOrders.has(c.companyKey), leadScore: s.score, leadGrade: s.grade, leadReasons: s.reasons };
    });
    res.json({ clients: scored });
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
      // Snoozed cards stay out of the call list until their snooze passes, then
      // return automatically (matches null or a past instant).
      $or: [{ snoozedUntil: null }, { snoozedUntil: { $lte: new Date() } }],
    })
      .sort({ nextFollowUp: 1 })   // soonest/most-overdue first (oldest date first)
      .lean();

    // Which of these companies have ≥1 PLACED order (⇒ customers)? One batched query.
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

    // isCustomer from order reality (a company with ≥1 linked PLACED Order is a
    // customer, even if its stored stage is a stale 'lead'). Same authoritative
    // signal /today, /pipeline and /dashboard use — so the calendar marks
    // customers the same way every other CRM surface does.
    const withOrders = await keysWithOrders(docs.map((c) => c.companyKey));

    const events = docs.map((c) => ({
      companyKey:   c.companyKey,
      name:         c.companyName || c.clientName || c.companyKey,
      phone:        c.phone || '',
      stage:        c.stage,
      interestType: c.interestType || '',
      area:         c.area || '',
      nextFollowUp: c.nextFollowUp,
      lastContact:  c.lastContact || null,
      isCustomer:   withOrders.has(c.companyKey),
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
    const { area, q, tag, leadSource } = req.query;
    const filter = { ...NOT_ARCHIVED };
    if (area) filter.area = area;
    // Structured lead-source filter — same enum the list endpoint uses, so the
    // board narrows by where the deals came from (?leadSource=Referral).
    if (leadSource && Client.LEAD_SOURCES.includes(leadSource)) filter.leadSource = leadSource;
    // ?q= is a global search (contacts/tags/identity) — same behavior as /list.
    const or = searchOr(q);
    if (or) filter.$or = or;
    else if (tag && String(tag).trim()) filter.tags = String(tag).trim();

    const clients = await Client.find(filter)
      .select('companyKey companyName clientName dealValue nextFollowUp stage address area interestType tags leadSource')
      .sort({ dealValue: -1, companyName: 1 })   // biggest deals first within each column
      .lean();

    // The unified board is ORDER-CENTRIC: lead/contacted columns come from Client
    // records (no live order), every order column comes from Order rows. We DON'T
    // pre-exclude archived/cancelled here — buildUnifiedBoard needs the cancelled
    // ones for the closed lane and drops archived itself.
    //
    // Order SCOPE: with no Client-field filter (the common case) the board shows
    // EVERY order — including order-only companies that have no Client row yet (a
    // freshly-minted quote from the lead→quote handoff, or a historical import).
    // Scoping orders to Client-derived keys would silently hide those, so when the
    // board is unfiltered we pull all non-archived orders. When a search/tag/area/
    // leadSource filter IS set, those are Client-field filters that an order-only
    // company can't satisfy anyway, so we scope orders to the filtered company keys.
    const filtered = !!(area || leadSource || (q && String(q).trim()) || (tag && tag !== 'all' && String(tag).trim()));
    const clientKeys = clients.map((c) => c.companyKey).filter(Boolean);
    let orders;
    if (filtered) {
      orders = clientKeys.length
        ? await Order.find({ companyKey: { $in: clientKeys }, archived: { $ne: true } })
            .select('companyKey companyName clientName projectNumber status totalValue archived orderDate createdAt updatedAt')
            .lean()
        : [];
    } else {
      orders = await Order.find({ archived: { $ne: true } })
        .select('companyKey companyName clientName projectNumber status totalValue archived orderDate createdAt updatedAt')
        .lean();
    }

    // The full key set the board touches = filtered companies ∪ companies that own
    // a board order. isCustomer (≥1 PLACED order) is keyed across that union.
    const keySet = new Set(clientKeys);
    for (const o of orders) if (o.companyKey) keySet.add(o.companyKey);
    const withOrders = await keysWithOrders(Array.from(keySet));

    // Company dealValue fallback for an order with no total yet (fresh $0 quote).
    const dealValueByKey = new Map();
    for (const c of clients) dealValueByKey.set(c.companyKey, Number(c.dealValue) || 0);

    const { groups, summary, columns } = buildUnifiedBoard({
      clients,
      orders,
      withPlacedOrders: withOrders,
      dealValueByKey,
    });

    res.json({
      groups,
      summary,
      probability: BOARD_PROBABILITY,
      // Board column ordering + which lane each belongs to, so the client renders
      // the unified set without hardcoding the column list (kept in sync server-side).
      columns,
      // The structured lead-source enum, so the board's filter dropdown can list
      // the exact filterable values without hardcoding them on the client.
      leadSources: Client.LEAD_SOURCES.filter(Boolean),
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
      .select('companyKey companyName clientName phone contacts dealValue stage address area interestType nextFollowUp lastContact log tags leadSource snoozedUntil updatedAt')
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
    const cockpit = buildCockpit(docs, nowMs, startTodayMs);

    // How many never-worked cold-outreach prospects are cluttering the book — the
    // count behind the dashboard's one-click "clear cold prospects" purge. Mirrors
    // the archiveCompanies({coldProspects}) predicate (minus the order check, which
    // only ever shrinks it — a cold prospect with an order is essentially nil).
    const coldProspects = docs.filter((c) => {
      const tags = (c.tags || []).map((t) => String(t).toLowerCase());
      if (tags.includes('warm')) return false;
      if (c.lastContact || c.nextFollowUp) return false;
      if (!['lead', 'contacted'].includes(c.stage)) return false;
      return c.leadSource === 'Cold Outreach' || tags.includes('dispensary') || tags.includes('cold-email');
    }).length;

    res.json({
      generatedAt: now.toISOString(),
      area: area || null,
      totalCompanies: docs.length,
      customersWithOrders, // authoritative customer count from order reality
      coldProspects,        // never-worked cold-outreach prospects (one-click purge)
      pipeline: {
        stages,
        totalOpenValue:    summary.totalOpenValue,
        weightedValue:     summary.weightedValue,
        weightedOpenValue: summary.weightedOpenValue,
        probability:       STAGE_PROBABILITY,
      },
      followUps: { overdue, dueToday, dueThisWeek },
      activity:  { touches7, touches30 },
      breakdowns: { byArea, byInterest },
      headsUp: {
        items:  heads.items,
        counts: heads.counts,
        total:  heads.total,
      },
      // Cadence cockpit — the same live book, grouped by NEXT ACTION so the owner
      // works top-down (your move → call today → close → mockup → on the rails).
      cockpit: {
        buckets: cockpit.buckets,
        counts:  cockpit.counts,
        total:   cockpit.total,
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

    const orders = await Order.find({ companyKey: key, archived: { $ne: true } })
      .sort({ orderDate: -1, createdAt: -1 })
      .select('projectNumber orderNumber status paid totalValue cogs orderDate createdAt')
      .lean();
    // ALL live orders (incl. quotes) are returned to the UI list above; only the
    // isCustomer flag below keys off a real PLACED order. Archived orders are
    // excluded so the duplicate-order sweep (archived twins) stops double-counting
    // this company's list AND its finance rollup below.

    // ── Linked POs ──────────────────────────────────────────────────────────────
    // POs hang off Orders (PurchaseOrder.orderId). Gather this company's order ids
    // → their POs, newest-first, as lean cards.
    const orderIds = orders.map((o) => o._id);
    const poDocs = orderIds.length
      ? await PurchaseOrder.find({ orderId: { $in: orderIds }, archived: { $ne: true } })
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

    // isCustomer is AUTHORITATIVE from order reality: a company is a customer iff
    // it has ≥1 linked Order in a REAL PLACED status (placed/in_production/shipped/
    // delivered) — a bare quote or approved-but-not-placed order does NOT count.
    // The frontend renders "Customer" off this boolean, and it stays reliable even
    // if the stored `stage` is stale. (ALL orders, including quotes, still show in
    // the list above; only this flag keys off placed.)
    const isCustomer = orders.some((o) => PLACED_STATUSES.includes(o.status));

    // ── Outreach enrollments ────────────────────────────────────────────────────
    // Any cold-email sequences this company is (or was) in, joined with the
    // campaign name — the detail card shows a compact status line and the
    // timeline already carries the per-send log touches.
    const enrDocs = await OutreachEnrollment.find({ companyKey: key })
      .sort({ updatedAt: -1 })
      .select('campaignId status stepIndex sends openCount lastOpenedAt repliedAt nextSendAt')
      .lean();
    let outreach = [];
    if (enrDocs.length) {
      const campaignDocs = await OutreachCampaign.find({ _id: { $in: enrDocs.map((e) => e.campaignId) } })
        .select('name steps').lean();
      const cById = new Map(campaignDocs.map((c) => [String(c._id), c]));
      outreach = enrDocs.map((e) => {
        const c = cById.get(String(e.campaignId));
        return {
          enrollmentId: e._id,
          campaignName: c ? c.name : '',
          status: e.status,
          sent: (e.sends || []).length,
          stepCount: c ? (c.steps || []).length : 0,
          openCount: e.openCount || 0,
          repliedAt: e.repliedAt || null,
          nextSendAt: e.nextSendAt || null,
        };
      });
    }

    res.json({ client: { ...client, isCustomer }, orders, pos, finance, isCustomer, outreach });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// Fields a normal PATCH may set directly.
const PATCHABLE = [
  'companyName', 'clientName', 'email', 'phone', 'paymentTerms',
  'defaultPrinter', 'defaultSupplier', 'defaultMarkup', 'notes',
  'stage', 'nextFollowUp', 'lastContact', 'snoozedUntil', 'address', 'area', 'interestType',
  'dealValue', 'contacts', 'source', 'tags', 'lostReason', 'doNotEmail', 'leadSource',
];

// Normalize a PATCHed contacts array: known fields only, strings trimmed, rows
// that are entirely blank dropped, and AT MOST ONE ★ primary (first starred one
// wins — the UI stars one at a time, this just makes the invariant unbreakable).
// Blanks are dropped BEFORE the star is assigned, so a starred-but-empty row
// can never consume the one primary and then vanish (which would silently
// un-star the real main contact). Pure + exported for tests.
function sanitizeContacts(raw) {
  let sawPrimary = false;
  return (Array.isArray(raw) ? raw : [])
    .map((c) => {
      const s = (v) => String(v == null ? '' : v).trim();
      return { name: s(c && c.name), role: s(c && c.role), phone: s(c && c.phone), email: s(c && c.email), isPrimary: !!(c && c.isPrimary) };
    })
    .filter((c) => c.name || c.role || c.phone || c.email)
    .map((c) => {
      const keep = c.isPrimary && !sawPrimary;
      if (keep) sawPrimary = true;
      return { ...c, isPrimary: keep };
    });
}

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

    // Field-map captures resolve identity at WRITE time before minting a new
    // company: the pin/stop key can be a derived key or a stale add-time
    // snapshot (a card created later under a different key would be missed,
    // and offline-queued captures replay hours old). If no card owns the key
    // but one fuzzy-matches the company name (the same matchKey join the map
    // uses), land the touch on that card instead of upserting a duplicate.
    // Scoped to field-map writes so ordinary CRM edits keep exact-key
    // semantics. A merged-away duplicate is never bound — its history lives
    // on the survivor, and re-engagement deliberately won't unarchive it.
    let targetKey = key;
    if (body.source === 'field-map' && !(await Client.exists({ companyKey: key }))) {
      const mk = deriveMatchKey(body.companyName || '', body.clientName || '');
      const alt = mk
        ? await Client.findOne({ matchKey: mk, $nor: [{ archived: true, archivedReason: 'merged' }] })
            .select('companyKey').lean()
        : null;
      if (alt && alt.companyKey) targetKey = alt.companyKey;
    }

    const set = {};
    const push = {};
    const setOnInsert = {};

    // Plain field edits.
    for (const f of PATCHABLE) {
      if (f in body) {
        if (f === 'stage' && body.stage && !STAGES.includes(body.stage)) {
          return res.status(400).json({ message: `invalid stage "${body.stage}"` });
        }
        if (f === 'leadSource' && body.leadSource && !Client.LEAD_SOURCES.includes(body.leadSource)) {
          return res.status(400).json({ message: `invalid leadSource "${body.leadSource}"` });
        }
        set[f] = body[f];
      }
    }

    // Contacts: sanitize the wholesale array (same mechanism tags use), then
    // mirror the ★ primary's phone/email to the legacy top-level fields — the
    // fields every surface (rows, Today, right-click Call/Text/Email, heads-up)
    // reads via primaryPhone/primaryEmail. Mirror NON-EMPTY values only (a
    // starred contact without a phone must not wipe a working number), and an
    // explicit phone/email in the SAME patch always wins over the mirror.
    if ('contacts' in body) {
      set.contacts = sanitizeContacts(body.contacts);
      const prim = set.contacts.find((c) => c.isPrimary);
      if (prim) {
        if (prim.phone && !('phone' in body)) set.phone = prim.phone;
        if (prim.email && !('email' in body)) set.email = prim.email;
      }
    }

    // Intent: capture ONE person from the field (Field Map's "who did I talk
    // to"). Merge-don't-replace: an existing contact (matched by phone/email —
    // mergeContacts — or by name when the capture carries neither) is blank-
    // filled; anyone new is appended; the ★ primary is never disturbed. This
    // is deliberately distinct from a `contacts` edit, which REPLACES the
    // whole array from the company card's editor.
    if (body.addContact && typeof body.addContact === 'object' && !('contacts' in body)) {
      const inc = sanitizeContacts([{ ...body.addContact, isPrimary: false }]);
      if (inc.length) {
        const c = inc[0];
        const cur = await Client.findOne({ companyKey: targetKey }).select('contacts').lean();
        const existing = (cur && cur.contacts) || [];
        // Match order: phone/email (the strong keys) via mergeContacts; else
        // the same NAME — the natural repeat-capture flow is "got the name
        // first, got their number the next visit", and that second capture
        // must enrich the existing person, never append a duplicate.
        const cp = normPhone(c.phone);
        const ce = normEmail(c.email);
        const keyMatch = (cp || ce)
          ? existing.find((ec) => (cp && normPhone(ec.phone) === cp) || (ce && normEmail(ec.email) === ce))
          : null;
        const nameKey = String(c.name || '').trim().toLowerCase();
        const nameMatch = !keyMatch && nameKey
          ? existing.find((ec) => String(ec.name || '').trim().toLowerCase() === nameKey)
          : null;
        if (nameMatch) {
          set.contacts = existing.map((ec) => (ec === nameMatch
            ? { ...ec, role: ec.role || c.role, phone: ec.phone || c.phone, email: ec.email || c.email }
            : ec));
        } else {
          set.contacts = mergeContacts(existing, [c]);
        }
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

    // Promote-only stage suggestion — the Field Map's visit/to-do capture (and
    // any other best-effort writer) sends `stageSuggest` instead of `stage`.
    // Two ATOMIC pieces, so the promote-only rule holds at write time even
    // against a concurrent owner edit (offline queues replay in bursts exactly
    // when the owner is back at the board):
    //   • an existing record moves forward ONLY via a stage-guarded updateOne
    //     — the filter re-checks promotableFrom at write time, so an owner
    //     move to lost/quoting/anywhere between read and replay always wins;
    //   • a fresh record seeds at the suggested stage via $setOnInsert.
    // An explicit `stage` in the same patch wins (that's a deliberate edit).
    if (body.stageSuggest && !('stage' in body)) {
      if (!STAGES.includes(body.stageSuggest)) {
        return res.status(400).json({ message: `invalid stage "${body.stageSuggest}"` });
      }
      setOnInsert.stage = body.stageSuggest;
      const from = promotableFrom(body.stageSuggest);
      if (from.length) {
        await Client.updateOne(
          {
            companyKey: targetKey,
            // ''/null/missing count as 'lead' (promotable). lost/dormant are
            // never in `from`, so owner-closed records never match.
            $or: [{ stage: { $in: from } }, { stage: null }, { stage: '' }, { stage: { $exists: false } }],
          },
          { $set: { stage: body.stageSuggest } },
        );
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

    set.companyKey = targetKey;

    // Customer permanence (ECOSYSTEM.md: "Customer status is permanent … lock the
    // stage so it can't regress to lead"). Server backstop for the frontend's
    // demote guard: never let a won/customer OR order-bearing company be dragged/
    // right-clicked back to a pre-customer stage. The regression is dropped (other
    // edits in the same patch still apply); dormant/lost stay allowed — those are
    // deliberate owner closes, and 'dormant' is explicitly fine for a cold customer.
    // (stageSuggest never lands in `set`, so promote-only field captures — which
    // can't regress anything — are not blocked here for order-bearing leads.)
    if ('stage' in set && PRE_CUSTOMER_STAGES.has(set.stage)) {
      const current = await Client.findOne({ companyKey: targetKey }).select('stage').lean();
      const isCustomerStage = current && (current.stage === 'won' || current.stage === 'customer');
      const hasOrders = (await keysWithOrders([targetKey])).has(targetKey);
      if (isCustomerStage || hasOrders) {
        delete set.stage;
        delete set.lostReason; // stage-coupled clear no longer applies
      }
    }

    // Re-engagement unarchives. A logged touch (Field Map "Add opportunity" /
    // "Log follow-up", CRM row Call/Text/Email) or a freshly scheduled future
    // follow-up on an archived card means the owner is working it again — bring
    // it back to the board instead of silently writing history into a hidden
    // record. Merged losers stay put: a merge is a dedupe decision, not
    // dormancy, and reviving the loser would recreate the duplicate.
    const reEngaged = hasLog || ('nextFollowUp' in set && !!set.nextFollowUp);
    if (reEngaged) {
      const cur = await Client.findOne({ companyKey: targetKey })
        .select('archived archivedReason').lean();
      if (cur && cur.archived && cur.archivedReason !== 'merged') {
        set.archived = false;
        set.archivedAt = null;
        set.archivedReason = '';
      }
    }

    const update = {};
    if (Object.keys(set).length)  update.$set  = set;
    if (Object.keys(push).length) update.$push = push;
    if (Object.keys(setOnInsert).length) update.$setOnInsert = setOnInsert;

    const client = await Client.findOneAndUpdate(
      { companyKey: targetKey },
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
  // controller may flag that this company has ≥1 linked PLACED Order (hasOrders) —
  // in which case it's a CUSTOMER, never a lead. We take the furthest-along of the
  // candidates but NEVER regress what the owner already advanced (won stays won,
  // a manual 'quoting' isn't pulled back to 'customer', etc.). promoteStage
  // moves up the funnel rank only.
  //   - an order (on the row OR already linked) ⇒ at least 'customer'
  //   - else the status-mapped stage, but only from a default/empty/lead doc
  // hasOrders means a VERIFIED placed Order (resolved by the caller against real
  // Order docs) — NOT the free-text mapped.hasOrderNumber hint, which never
  // promotes on its own. Only this flag may lift a record to 'customer'.
  const hasOrders = !!opts.hasOrders;
  // First, the status-derived stage — original contract: only fills a doc still
  // sitting at the import-default floor (empty / 'lead'); never overrides an
  // owner-advanced stage. CRITICAL: a status WORD must NEVER set 'customer' —
  // "customer" is reserved for a verified PLACED Order (the hasOrders branch
  // below). The importer no longer emits stage 'customer', but we hard-guard here
  // too so a stray value can't slip a quote-only record to customer.
  if (mapped.stage && mapped.stage !== 'customer' && (!doc.stage || doc.stage === 'lead')) {
    doc.stage = mapped.stage;
  }
  // Then order-promotion: a real PLACED Order (on the row OR already in the DB)
  // means CUSTOMER. promoteStage moves UP only and refuses to touch lost/dormant,
  // so a won deal stays won, a manual mid-funnel stage isn't regressed, and a
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

  // Does this company already have ≥1 REAL PLACED Order? Only that makes it a
  // customer — a free-text order-number cell on the CSV (mapped.hasOrderNumber) is
  // NOT proof and must not promote. The caller may pre-compute a Set of
  // placed-order keys (opts.keysWithOrders — already filtered to PLACED_STATUSES)
  // to avoid a per-row query; otherwise we look one up with the same filter.
  let hasOrders;
  if (opts.keysWithOrders) hasOrders = opts.keysWithOrders.has(key);
  else hasOrders = !!(await Order.findOne({ companyKey: key, status: { $in: PLACED_STATUSES } }).select('_id').lean());

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

    // Pre-compute which incoming companies already have ≥1 PLACED order, in ONE
    // query, so the per-row order→customer promotion doesn't fan out into N lookups.
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
  'order-ref',
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

// Which of these companyKeys are CUSTOMERS — i.e. have at least one REAL PLACED
// order (status in PLACED_STATUSES). A bare quote/approved/cancelled order does
// NOT make a company a customer, so it's excluded here. This single query keys
// isCustomer across listCrm / getToday / getPipeline / getDashboard at once.
async function keysWithOrders(keys) {
  if (!keys.length) return new Set();
  const rows = await Order.find({
    companyKey: { $in: keys },
    status: { $in: PLACED_STATUSES },
  }).select('companyKey').lean();
  return new Set(rows.map((r) => r.companyKey));
}

// Which of these companyKeys have ANY linked Order at all — including a live
// quote (quoted/approved). This is the ARCHIVE/SWEEP-PROTECTION signal: "any
// order means real history worth keeping visible", deliberately broader than the
// customer test above. Used by the cleanup/replace safety gates so a real
// prospect mid-deal (only a quote so far) is never archived out of the working
// set. NOT a customer signal — isCustomer still keys off placed orders only.
async function keysWithAnyOrder(keys) {
  if (!keys.length) return new Set();
  const rows = await Order.find({ companyKey: { $in: keys } }).select('companyKey').lean();
  return new Set(rows.map((r) => r.companyKey));
}

// Auto-archive DEAD cold-outreach prospects so the owner never has to click the
// "Clear N cold prospects" banner — the outreach system cleans up after itself.
// "Dead" = the same cold-prospect predicate the manual clear uses, NARROWED to the
// ones that are truly finished: opted-out/bounced (doNotEmail) OR stale (created
// > COLD_STALE_DAYS ago with zero engagement). Fresh, still-in-sequence prospects
// are left alone (they haven't had a chance to reply). Soft + reversible — a reply
// auto-unarchives via warm-handoff — and a company with ANY order is never touched.
// Called on a daily cron (services/crmScheduler.js). Returns { archived, keys }.
const COLD_STALE_DAYS = parseInt(process.env.CRM_COLD_STALE_DAYS || '60', 10);
async function autoArchiveDeadColdProspects() {
  const staleBefore = new Date(Date.now() - COLD_STALE_DAYS * 86400000);
  const candidates = await Client.find({
    ...NOT_ARCHIVED,
    lastContact: null,
    nextFollowUp: null,
    stage: { $in: ['lead', 'contacted'] },
    tags: { $nin: ['warm'] },
    $and: [
      { $or: [{ leadSource: 'Cold Outreach' }, { tags: { $in: ['dispensary', 'cold-email'] } }] },
      { $or: [{ doNotEmail: true }, { createdAt: { $lte: staleBefore } }] },
    ],
  }).select('companyKey').lean();
  const keyList = candidates.map((c) => c.companyKey);
  if (!keyList.length) return { archived: 0, keys: [] };
  const withOrders = await keysWithAnyOrder(keyList);
  const keys = keyList.filter((k) => !withOrders.has(k));
  if (!keys.length) return { archived: 0, keys: [] };
  const result = await Client.updateMany(
    { companyKey: { $in: keys }, ...NOT_ARCHIVED },
    { $set: { archived: true, archivedAt: new Date(), archivedReason: 'auto-cold-cleanup' } },
  );
  return { archived: result.modifiedCount != null ? result.modifiedCount : (result.nModified || 0), keys };
}

async function findReplaceable() {
  const candidates = await Client.find({ source: { $in: IMPORT_SOURCES }, ...NOT_ARCHIVED })
    .select('companyKey stage dealValue tags notes log source').lean();
  // PROTECTION gate: shield ANY company with order history (incl. a live quote),
  // not just placed customers — a real prospect mid-deal must survive a replace.
  const withOrders = await keysWithAnyOrder(candidates.map((c) => c.companyKey));
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

// Group likely-duplicate Client docs — the PURE core of /duplicates (no DB), so
// the grouping (incl. the typo-tolerance) is unit-testable.
//
// Two passes:
//   1) EXACT matchKey buckets (corp-suffix/punct/apostrophe stripped) — the
//      established grouping that catches "Acme" vs "Acme, Inc.".
//   2) CONSERVATIVE typo coalescing — fold two distinct buckets together when
//      their keys are a tiny spelling slip apart (matchKeysFuzzyEqual), so
//      "Happy Leaf Dispensary" and "Happy Leaf Dispesary" (a missing 'n') become
//      ONE group. The guard rails in matchKeysFuzzyEqual keep genuinely different
//      companies apart, so this never invents a false merge.
//
// Returns an array of groups; each group is an array of DISTINCT-companyKey docs
// with 2+ members (a singleton is not a duplicate). Order is stable-ish (first
// appearance), which the caller re-sorts for the UI.
function groupDuplicateDocs(docs) {
  // 1) Exact buckets, keyed by matchKey (backfilled for legacy docs).
  const buckets = new Map(); // matchKey -> docs[]
  for (const d of (docs || [])) {
    const mk = d.matchKey || deriveMatchKey(d.companyName, d.clientName);
    if (!mk) continue;
    const arr = buckets.get(mk) || [];
    arr.push(d);
    buckets.set(mk, arr);
  }

  // 2) Union-find over the DISTINCT matchKeys, joining typo-close pairs. O(k²) on
  //    the number of distinct keys (k, not the row count) — small in practice.
  const keys = [...buckets.keys()];
  const parent = new Map(keys.map((k) => [k, k]));
  const find = (k) => { let r = k; while (parent.get(r) !== r) r = parent.get(r); while (parent.get(k) !== r) { const n = parent.get(k); parent.set(k, r); k = n; } return r; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (matchKeysFuzzyEqual(keys[i], keys[j])) union(keys[i], keys[j]);
    }
  }

  // Collect each union-find component's docs, de-duped by companyKey.
  const byRoot = new Map(); // rootKey -> Map(companyKey -> doc)
  for (const k of keys) {
    const root = find(k);
    const m = byRoot.get(root) || new Map();
    for (const d of buckets.get(k)) if (!m.has(d.companyKey)) m.set(d.companyKey, d);
    byRoot.set(root, m);
  }

  const out = [];
  for (const m of byRoot.values()) {
    const distinct = [...m.values()];
    if (distinct.length > 1) out.push(distinct);
  }
  return out;
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

    // Group by matchKey — exact first, then conservatively coalesce near-identical
    // keys so a TYPO'd duplicate ("Happy Leaf Dispensary" vs "Happy Leaf Dispesary")
    // surfaces too. The fuzzy step is guard-railed (see matchKeysFuzzyEqual) so two
    // genuinely different companies never fold together. Pure + unit-tested.
    const dupGroups = groupDuplicateDocs(docs);
    const allKeys = [];
    dupGroups.forEach((arr) => arr.forEach((d) => allKeys.push(d.companyKey)));
    // Merge tooling: "has order history" (incl. a live quote) is the signal for
    // survivor preference + the UI's hasOrders hint — broader than the customer
    // flag, so a quote-only duplicate isn't treated as a blank record on merge.
    const withOrders = await keysWithAnyOrder(allKeys);

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

// Forward-progress rank for a merge stage-fold — ranks won/customer highest and
// the closed off-ramps (lost/dormant) lowest, so merging a dead duplicate into a
// live client never regresses the survivor. (STAGES enum order can't be used here:
// it lists lost/dormant after won/customer.)
const MERGE_STAGE_RANK = { lead: 1, contacted: 2, quoting: 3, won: 5, customer: 5, lost: 0, dormant: 0 };

// Every collection keyed by companyKey that a merge must re-home onto the survivor
// (besides Orders, handled explicitly). Deal is the load-bearing one — without it,
// a merged company's deals stay pinned to the archived loser key and the pipeline
// attaches to a dead company. `withName` also refreshes the denormalized
// companyName so future reads/writes stay consistent. Best-effort per collection.
const MERGE_REPOINT_MODELS = [
  { name: 'Deal',              withName: true  },
  { name: 'OutreachEnrollment', withName: false },
  { name: 'TriageReply',       withName: false },
  { name: 'ClientLogo',        withName: false },
  { name: 'FieldRun',          withName: false },
  { name: 'Dispensary',        withName: false },
];

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
  // Stage: keep whichever is further along the funnel — but by FORWARD PROGRESS,
  // not raw enum order. STAGES lists lost/dormant AFTER won/customer, so a naive
  // index would let a dead duplicate regress a live client to lost/dormant on merge.
  // MERGE_STAGE_RANK ranks won/customer highest and the closed off-ramps lowest, so
  // a merge never demotes a client. (Mirrors reconcile's furthest-stage guard.)
  if ((MERGE_STAGE_RANK[merged.stage] || 0) > (MERGE_STAGE_RANK[survivor.stage] || 0)) survivor.stage = merged.stage;
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

    // RE-POINT every OTHER companyKey-keyed collection too (Deals especially), so a
    // merge re-homes the whole ecosystem — not just orders. Best-effort per model:
    // a missing/odd collection can't fail the merge (Orders + the survivor already
    // saved). Deals stranded on the archived loser key were the sharp bug here.
    const repointed = {};
    for (const { name, withName } of MERGE_REPOINT_MODELS) {
      try {
        const M = require(`../models/${name}`);
        const set = { companyKey: survivorKey };
        if (withName) set.companyName = survivor.companyName || '';
        const r = await M.updateMany({ companyKey: mergedKey }, { $set: set });
        repointed[name] = r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
      } catch (e) { repointed[name] = 0; }
    }

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
      dealsRepointed: repointed.Deal || 0,
      repointed,
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
        // Protect ANY order-bearing company (incl. a live quote), per the safety
        // note above — broader than the customer test on purpose.
        const withOrders = await keysWithAnyOrder(requested);
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
      // Never sweep a record with ANY order (incl. a live quote) or owner activity.
      const withOrders = await keysWithAnyOrder(keyList);
      keys = candidates
        .filter((c) => !withOrders.has(c.companyKey) && !ownerTouched(c))
        .map((c) => c.companyKey);
    } else if (body.coldProspects === true || body.coldProspects === 'true') {
      // One-click "clear the cold-outreach book": the lead-finder / mail-merge
      // prospects the owner never personally worked. STRICT predicate so a real
      // client or an engaged lead can NEVER be caught:
      //   • cold-outreach origin (leadSource 'Cold Outreach' OR a dispensary/
      //     cold-email tag), AND
      //   • never replied (no 'warm' tag) AND never personally contacted
      //     (lastContact null) AND nothing scheduled (nextFollowUp null), AND
      //   • still an early stage (lead/contacted), AND (below) NO order of any kind.
      // Soft-archive only — reversible, and the outreach engine still re-enrolls
      // from archived? No: archived drops out of the enroll pool, which is the
      // intent here (the owner is clearing them, not pausing). A reply still
      // auto-unarchives via warm-handoff.
      reason = 'cold-prospect-cleanup';
      const candidates = await Client.find({
        ...NOT_ARCHIVED,
        lastContact: null,
        nextFollowUp: null,
        stage: { $in: ['lead', 'contacted'] },
        tags: { $nin: ['warm'] },
        $or: [{ leadSource: 'Cold Outreach' }, { tags: { $in: ['dispensary', 'cold-email'] } }],
      }).select('companyKey').lean();
      const keyList = candidates.map((c) => c.companyKey);
      const withOrders = await keysWithAnyOrder(keyList);
      keys = keyList.filter((k) => !withOrders.has(k));
    } else {
      return res.status(400).json({ message: 'Provide { keys: [...] }, { deadNoFollowUp: true }, or { coldProspects: true }' });
    }

    // Preview mode — report what WOULD be archived without writing anything.
    if (body.preview === true || body.preview === 'true') {
      return res.json({ ok: true, preview: true, wouldArchive: keys.length, keys });
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

// PATCH /api/crm/:companyKey/log/:entryId — reword ONE logged touch (fix a typo,
// tighten a note) without disturbing its timestamp or kind unless the caller
// sends one. Targets the entry by _id with the SAME numeric-index fallback the
// delete uses, so legacy entries that predate stable ids are editable too.
async function updateLogEntry(req, res) {
  try {
    const key = req.params.companyKey;
    const id = String(req.params.entryId == null ? '' : req.params.entryId);
    if (!key) return res.status(400).json({ message: 'companyKey required' });
    const body = req.body || {};
    const doc = await Client.findOne({ companyKey: key });
    if (!doc) return res.status(404).json({ message: 'No CRM record for that key.' });

    const arr = Array.isArray(doc.log) ? doc.log : [];
    let idx = arr.findIndex((e) => e && e._id != null && String(e._id) === id);
    if (idx < 0 && /^\d+$/.test(id)) {
      const n = Number(id);
      if (n >= 0 && n < arr.length) idx = n;
    }
    if (idx < 0) return res.status(404).json({ message: 'Log entry not found.' });

    if (typeof body.text === 'string') {
      const text = body.text.trim();
      if (!text) return res.status(400).json({ message: 'text cannot be empty — delete the entry instead' });
      arr[idx].text = text;
    }
    if (typeof body.kind === 'string' && body.kind) arr[idx].kind = body.kind;
    doc.markModified('log');
    await doc.save();
    res.json({ ok: true, client: doc.toObject() });
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

// ── Dedup-on-entry: "did you mean an existing company?" ─────────────────────────
// When the owner types a NEW company name, we surface the most likely EXISTING
// records BEFORE a card is created — so an accidental duplicate never gets made.
// This is the same dedup philosophy as the duplicate finder (matchKey + a light
// fuzzy fallback), but applied live against a single typed name. It only ever
// SUGGESTS: the caller is free to ignore every candidate and create a genuinely
// new, distinct company. Nothing here merges, blocks, or mutates.

// Tokenize a name into lowercased word tokens (apostrophes folded, punctuation
// dropped). Mirrors the vendor dedup tokenizer so the two read the same.
function nameTokens(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/['’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Is token array `a` an in-order prefix of `b`? ("bleu leaf" ⊂ "bleu leaf
// dispensary"). Order matters, so "leaf bleu" is NOT a prefix.
function isNameTokenPrefix(a, b) {
  if (a.length === 0 || a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Jaccard overlap of two token SETS (|A∩B| / |A∪B|), 0..1.
function nameTokenJaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union ? inter / union : 0;
}

// Score how strongly a typed name matches one existing record. Returns
//   { score: 0..1, reason } — higher = more confident it's the SAME company.
// Tiers (most → least confident), reusing the CRM matchKey as the strong signal:
//   1.00  identical IDENTITY key (companyKey) — already that exact company
//   0.92  identical fuzzy matchKey (corp-suffix/punct/apostrophe stripped):
//         "Acme Inc" ≈ "Acme, Inc." (same stem)
//   0.78  one name's tokens are an in-order prefix of the other AND the shorter
//         stem is meaningful (≥3 chars) — "Acme" vs "Acme Apparel" (a likely
//         dupe worth surfacing as a SUGGESTION, never an auto-merge)
//   0.60..0.75  strong token-set overlap (Jaccard ≥ 0.5), scaled by overlap
// Anything weaker scores 0 (not a candidate). Empty inputs never match.
function scoreNameMatch(typedKey, typedMatchKey, typedTokens, rec) {
  const recKey = rec.companyKey || '';
  if (!typedKey || !recKey) return { score: 0, reason: '' };
  if (recKey === typedKey) return { score: 1, reason: 'exact' };

  const recMatch = rec.matchKey || deriveMatchKey(rec.companyName, rec.clientName);
  if (typedMatchKey && recMatch && recMatch === typedMatchKey) {
    return { score: 0.92, reason: 'matchKey' };
  }
  // Typo tier: the match keys are the same name with a tiny spelling slip
  // ("happyleafdispensary" ≈ "happyleafdispesary"). Surfaced as a strong (but
  // sub-exact) suggestion so a misspelled duplicate gets caught at entry time.
  // matchKeysFuzzyEqual is conservatively guard-railed, so this never proposes a
  // genuinely different company.
  if (typedMatchKey && recMatch && matchKeysFuzzyEqual(typedMatchKey, recMatch)) {
    return { score: 0.88, reason: 'matchKey-typo' };
  }

  const recTokens = nameTokens(rec.companyName || rec.clientName || rec.companyKey);
  if (typedTokens.length && recTokens.length) {
    const shorter = typedTokens.length <= recTokens.length ? typedTokens : recTokens;
    const longer  = shorter === typedTokens ? recTokens : typedTokens;
    const shortStem = shorter.join('');
    if (shortStem.length >= 3 && isNameTokenPrefix(shorter, longer)) {
      return { score: 0.78, reason: 'prefix' };
    }
    const j = nameTokenJaccard(typedTokens, recTokens);
    if (j >= 0.5) return { score: 0.6 + 0.15 * Math.min(1, (j - 0.5) / 0.5), reason: 'overlap' };
  }
  return { score: 0, reason: '' };
}

// Rank existing records against a typed company name — the pure core of the
// match endpoint (no DB / no Express, so it's unit-testable). `docs` are lean
// Client POJOs ({ companyKey, companyName, clientName, matchKey, stage, ... }).
// Options: { limit = 5, excludeKey } drops the record being edited (so editing a
// company never flags itself). Returns the top candidates, most-confident first,
// each a compact card the UI shows as "did you mean <name>?". SUGGEST-only.
function rankMatchCandidates(name, docs, opts = {}) {
  const typedKey = deriveCompanyKey(name, '');
  if (!typedKey) return [];                        // nothing typed yet → no suggestions
  const typedMatchKey = deriveMatchKey(name, '');
  const typedTokens   = nameTokens(name);
  const excludeKey    = opts.excludeKey || '';
  const limit = Math.max(1, Math.min(25, Number(opts.limit) || 5));

  const scored = [];
  for (const rec of (docs || [])) {
    if (!rec || !rec.companyKey) continue;
    if (excludeKey && rec.companyKey === excludeKey) continue;
    const { score, reason } = scoreNameMatch(typedKey, typedMatchKey, typedTokens, rec);
    if (score <= 0) continue;
    scored.push({
      companyKey:   rec.companyKey,
      name:         rec.companyName || rec.clientName || rec.companyKey,
      stage:        rec.stage || 'lead',
      isCustomer:   !!rec.isCustomer,
      address:      rec.address || '',
      lastContact:  rec.lastContact || null,
      score:        Math.round(score * 100) / 100,
      reason,
    });
  }
  // Most-confident first; tie-break a real customer ahead, then by name so the
  // ordering is stable for the UI.
  scored.sort((a, b) =>
    b.score - a.score
    || (b.isCustomer ? 1 : 0) - (a.isCustomer ? 1 : 0)
    || String(a.name).localeCompare(String(b.name)));
  return scored.slice(0, limit);
}

// GET /api/crm/match?name=&excludeKey=&limit= — dedup-on-entry suggestions.
// Returns the existing companies that most likely ALREADY ARE the one being
// typed, so the owner can reuse a card instead of making a duplicate. Pure
// suggestions — the client decides; this endpoint never merges or blocks.
async function matchCandidates(req, res) {
  try {
    const name = String(req.query.name || '').trim();
    // Too-short / empty input: return an empty candidate list (not an error) so
    // the UI can call this on every keystroke without noise.
    if (name.length < 2) return res.json({ query: name, candidates: [] });

    // Search non-archived records only — a duplicate suggestion should point at a
    // live card, not a soft-deleted one. Narrow the scan with a coarse $or
    // (matchKey OR a loose name regex) so we don't load the whole book, then do
    // the precise ranking in memory.
    const typedMatchKey = deriveMatchKey(name, '');
    const firstToken = nameTokens(name)[0] || '';
    const or = [];
    if (typedMatchKey) or.push({ matchKey: typedMatchKey });
    if (firstToken) {
      const rx = new RegExp(firstToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      or.push({ companyName: rx }, { clientName: rx }, { companyKey: rx });
    }
    const filter = or.length ? { ...NOT_ARCHIVED, $or: or } : { ...NOT_ARCHIVED };
    const docs = await Client.find(filter)
      .select('companyKey companyName clientName matchKey stage address lastContact')
      .limit(400)
      .lean();

    const candidates = rankMatchCandidates(name, docs, {
      excludeKey: req.query.excludeKey,
      limit: req.query.limit,
    });
    // Flag which suggestions are real customers (placed an order) so the UI can
    // mark them — keys off order reality, the Phase-1 signal, not the stage text.
    if (candidates.length) {
      const withOrders = await keysWithOrders(candidates.map((c) => c.companyKey));
      candidates.forEach((c) => { c.isCustomer = withOrders.has(c.companyKey); });
    }
    res.json({ query: name, candidates });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// One-time repair (run on boot; idempotent): fold RETIRED stages onto their
// nearest live stage — 'sampling' → 'quoting' (owner retired it as not useful).
// updateMany bypasses enum validation, and once no doc carries a retired stage
// this is a no-op. Archived records are migrated too (a restore must come back
// with a valid stage).
async function migrateRetiredStages() {
  const r = await Client.updateMany({ stage: 'sampling' }, { $set: { stage: 'quoting' } });
  return r.modifiedCount != null ? r.modifiedCount : (r.nModified || 0);
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
  autoArchiveDeadColdProspects,
  deleteLogEntry,
  updateLogEntry,
  archiveOne,
  unarchiveOne,
  matchCandidates,
  migrateRetiredStages,
  // exported for tests / reuse
  promotableFrom,
  sanitizeContacts,
  rankMatchCandidates,
  scoreNameMatch,
  groupDuplicateDocs,
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
  // Unified order-centric board (pure, unit-tested).
  orderStatusToColumn,
  buildUnifiedBoard,
  summarizeBoard,
  isLiveOrderRow,
  orderCardKey,
  BOARD_COLUMNS,
  BOARD_CLOSED_COLUMNS,
  BOARD_PROBABILITY,
  DELIVERED_CAP,
  classifyHeadsUp,
  buildHeadsUp,
  HEADS_UP,
  isEngineManagedCold,
  isOutreachPool,
  isColdDeadWeight,
  cadenceBucketFor,
  buildCockpit,
  CADENCE_BUCKETS,
  promoteStage,
  promoteCompanyToCustomerOnPlacement,
  ensureCompanyForQuoting,
  removeLogEntry,
  searchOr,
};
