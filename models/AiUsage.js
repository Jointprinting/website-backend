// models/AiUsage.js
//
// One document per ET calendar month (YYYY-MM) tracking ESTIMATED Anthropic
// spend for the JP Webworks AI copywriter (services/jpwCopywriter.js →
// controllers/jpwSites.js generateCopy). This is the guardrail behind the
// owner's Anthropic balance: the Studio reads it to warn / hard-stop before a
// runaway "generate" loop silently drains his credit.
//
// Why a Mongo doc (mirrors JpwApiUsage): Render restarts the dyno regularly; an
// in-memory counter would forget the month's spend. A tiny doc per month costs
// ~nothing and survives restarts.
//
//   estCostUsd      accumulated estimate (see services/aiBudget.js for the
//                   input/output per-MTok rates — env-overridable estimates)
//   calls           successful generate calls this month
//   inputTokens /   raw token totals from each call's `usage` (for auditing the
//   outputTokens    estimate later)
//   generatesByDay  { 'YYYY-MM-DD' (ET) : count } — per-day generate counter the
//                   daily-cap guard reads. Small (≤31 keys/month).

const mongoose = require('mongoose');

const AiUsageSchema = new mongoose.Schema({
  month:          { type: String, required: true, unique: true }, // 'YYYY-MM' (ET)
  estCostUsd:     { type: Number, default: 0 },
  calls:          { type: Number, default: 0 },
  inputTokens:    { type: Number, default: 0 },
  outputTokens:   { type: Number, default: 0 },
  generatesByDay: { type: Object, default: {} },                  // { 'YYYY-MM-DD' (ET): count }
  updated_at:     { type: Date, default: Date.now },
});

module.exports = mongoose.model('AiUsage', AiUsageSchema);
