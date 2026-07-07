// services/aiBudget.js
//
// AI-credit guardrails for the ONE Anthropic-spending feature this app has: the
// JP Webworks copy generator (services/jpwCopywriter.js). It does three things,
// all cheap:
//
//   1. preflight()  — a hard blocker run BEFORE the model is called: refuses when
//                     this ET-month's estimated spend hits the budget, or the
//                     day's generate count hits the cap. No token is spent to
//                     find out we're over budget.
//   2. recordUsage()— best-effort accounting AFTER a successful call, from the
//                     Anthropic response's `usage` object. Must never break the
//                     response (caller wraps it in try/catch).
//   3. getStatus()  — the snapshot the Studio hub + JPW Websites tab render.
//
// The cost is an ESTIMATE. Rates default to Claude Sonnet-tier list price
// ($3 / $15 per million input / output tokens) and are env-overridable so they
// track whatever model/pricing is actually in use. Everything money-related is
// reasoned in the business timezone (ET) via utils/time, so the monthly budget
// rolls over on the owner's calendar, not the server's UTC one.

const AiUsage = require('../models/AiUsage');
const { etToday } = require('../utils/time');

// ── Config (env-overridable estimates; keep in sync with the frontend copy) ──
// Defaults documented in .env.example. IN/OUT rates are Sonnet-tier list price;
// bump them if a pricier model is wired in or Anthropic changes pricing.
const DEFAULT_IN_RATE_USD_PER_MTOK = 3.0;   // input  $/million tokens
const DEFAULT_OUT_RATE_USD_PER_MTOK = 15.0; // output $/million tokens
const DEFAULT_MONTHLY_BUDGET_USD = 5;
const DEFAULT_DAILY_GENERATE_CAP = 40;

// Parse an env number, falling back to `dflt` for missing / bad / negative values.
function envNum(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}
function inRateUsdPerMtok()  { return envNum(process.env.AI_IN_RATE_USD_PER_MTOK, DEFAULT_IN_RATE_USD_PER_MTOK); }
function outRateUsdPerMtok() { return envNum(process.env.AI_OUT_RATE_USD_PER_MTOK, DEFAULT_OUT_RATE_USD_PER_MTOK); }
function monthlyBudgetUsd()  { return envNum(process.env.AI_MONTHLY_BUDGET_USD, DEFAULT_MONTHLY_BUDGET_USD); }
function dailyGenerateCap()  { return envNum(process.env.AI_DAILY_GENERATE_CAP, DEFAULT_DAILY_GENERATE_CAP); }

// ── PURE helpers (unit-tested in services/__tests__/aiBudget.test.js) ────────

// The ET calendar month / day of an instant, as 'YYYY-MM' / 'YYYY-MM-DD'.
// Reuses the business-timezone day logic so the budget rolls over on the owner's
// calendar (e.g. late-evening ET is still "today", not tomorrow's UTC date).
function monthKey(now = new Date()) { return etToday(now).slice(0, 7); }
function dayKey(now = new Date())   { return etToday(now); }

// Estimated USD cost of one call from its Anthropic `usage` object. Only
// input_tokens/output_tokens are counted (cache tokens are ignored — this is a
// budgeting estimate, not a billing ledger).
function estCostFromUsage(usage, inRate = inRateUsdPerMtok(), outRate = outRateUsdPerMtok()) {
  const u = usage || {};
  const inTok  = Number(u.input_tokens)  || 0;
  const outTok = Number(u.output_tokens) || 0;
  return (inTok / 1e6) * inRate + (outTok / 1e6) * outRate;
}

// Budget level from spend vs budget:
//   'ok'      under 80%
//   'warn'    >= 80% of budget
//   'blocked' >= 100% of budget
// A non-positive / invalid budget means "no budget configured" → always 'ok'.
function aiBudgetLevel(estCost, budget) {
  const b = Number(budget);
  if (!Number.isFinite(b) || b <= 0) return 'ok';
  const c = Number(estCost) || 0;
  if (c >= b) return 'blocked';
  if (c >= 0.8 * b) return 'warn';
  return 'ok';
}

// ── DB-backed operations ─────────────────────────────────────────────────────

// Fields the current month's doc contributes (0s when no doc exists yet).
async function readMonth(now = new Date()) {
  const month = monthKey(now);
  const doc = await AiUsage.findOne({ month }).lean();
  const estCostUsd = doc ? Number(doc.estCostUsd) || 0 : 0;
  const byDay = (doc && doc.generatesByDay) || {};
  const callsToday = Number(byDay[dayKey(now)]) || 0;
  return { month, estCostUsd, callsToday };
}

// The snapshot rendered by the Studio. `configured` is layered on by the caller
// (it knows whether ANTHROPIC_API_KEY is set).
async function getStatus(now = new Date()) {
  const { month, estCostUsd, callsToday } = await readMonth(now);
  const budgetUsd = monthlyBudgetUsd();
  const dailyCap = dailyGenerateCap();
  const pct = budgetUsd > 0 ? estCostUsd / budgetUsd : 0;
  return {
    month,
    estCostUsd,
    budgetUsd,
    pct,
    callsToday,
    dailyCap,
    level: aiBudgetLevel(estCostUsd, budgetUsd),
  };
}

// Cheap pre-call guard. Returns { ok: true } to proceed, or
// { ok: false, status, message } to short-circuit — BEFORE any token is spent.
async function preflight(now = new Date()) {
  const { estCostUsd, callsToday } = await readMonth(now);
  const budgetUsd = monthlyBudgetUsd();
  const dailyCap = dailyGenerateCap();

  if (budgetUsd > 0 && estCostUsd >= budgetUsd) {
    return {
      ok: false,
      status: 402,
      message: `AI budget reached for this month ($${estCostUsd.toFixed(2)} of $${budgetUsd.toFixed(2)}). Top up your Anthropic credit and raise AI_MONTHLY_BUDGET_USD, or wait for next month.`,
    };
  }
  if (dailyCap > 0 && callsToday >= dailyCap) {
    return {
      ok: false,
      status: 429,
      message: `Daily AI generate limit reached (${callsToday} of ${dailyCap} today). It resets tomorrow — or raise AI_DAILY_GENERATE_CAP.`,
    };
  }
  return { ok: true };
}

// Record one successful generate's estimated cost + token totals, and bump the
// day's generate counter. Best-effort: the caller wraps this so a bookkeeping
// failure never breaks the copy that was already generated. Returns the cost.
async function recordUsage(usage, now = new Date()) {
  const month = monthKey(now);
  const day = dayKey(now);
  const u = usage || {};
  const cost = estCostFromUsage(usage);
  await AiUsage.updateOne(
    { month },
    {
      $inc: {
        estCostUsd: cost,
        calls: 1,
        inputTokens: Number(u.input_tokens) || 0,
        outputTokens: Number(u.output_tokens) || 0,
        [`generatesByDay.${day}`]: 1,
      },
      $set: { updated_at: new Date() },
    },
    { upsert: true }
  );
  return cost;
}

module.exports = {
  // pure helpers (unit-tested)
  monthKey, dayKey, estCostFromUsage, aiBudgetLevel,
  // config getters
  inRateUsdPerMtok, outRateUsdPerMtok, monthlyBudgetUsd, dailyGenerateCap,
  // DB ops
  getStatus, preflight, recordUsage,
};
