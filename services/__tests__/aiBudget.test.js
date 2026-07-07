// services/__tests__/aiBudget.test.js
//
// AI-credit guardrail pure-logic checks (no DB, no network):
//
//   node --test services/__tests__/aiBudget.test.js
//
// The money-sensitive parts are the cost estimate (from a call's token usage),
// the budget-level thresholds (what turns the Studio amber vs red), and the
// ET month/day keys the budget rolls over on. Those are the pure helpers, so
// they get the coverage.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  monthKey, dayKey, estCostFromUsage, aiBudgetLevel,
} = require('../aiBudget');

// ── Cost from usage ───────────────────────────────────────────────────────────
test('estCostFromUsage bills input + output tokens at the given per-MTok rates', () => {
  // 1M in + 1M out at 3/15 → $3 + $15 = $18.
  assert.equal(estCostFromUsage({ input_tokens: 1e6, output_tokens: 1e6 }, 3, 15), 18);
  // 500k in + 200k out at 3/15 → 0.5*3 + 0.2*15 = 1.5 + 3 = 4.5.
  assert.equal(estCostFromUsage({ input_tokens: 500000, output_tokens: 200000 }, 3, 15), 4.5);
});

test('estCostFromUsage defaults to Sonnet-tier rates (3 / 15) when none passed', () => {
  // With no env override, defaults are 3.0 / 15.0.
  assert.equal(estCostFromUsage({ input_tokens: 1e6, output_tokens: 0 }), 3);
  assert.equal(estCostFromUsage({ input_tokens: 0, output_tokens: 1e6 }), 15);
});

test('estCostFromUsage treats a missing / malformed usage object as $0', () => {
  assert.equal(estCostFromUsage(null, 3, 15), 0);
  assert.equal(estCostFromUsage(undefined, 3, 15), 0);
  assert.equal(estCostFromUsage({}, 3, 15), 0);
  assert.equal(estCostFromUsage({ input_tokens: 'x', output_tokens: null }, 3, 15), 0);
});

// ── Budget level thresholds ───────────────────────────────────────────────────
test('aiBudgetLevel: ok below 80%, warn at/above 80%, blocked at/above 100%', () => {
  assert.equal(aiBudgetLevel(0, 5), 'ok');
  assert.equal(aiBudgetLevel(3.99, 5), 'ok');    // just under 80%
  assert.equal(aiBudgetLevel(4, 5), 'warn');     // exactly 80%
  assert.equal(aiBudgetLevel(4.5, 5), 'warn');
  assert.equal(aiBudgetLevel(5, 5), 'blocked');  // exactly 100%
  assert.equal(aiBudgetLevel(9, 5), 'blocked');  // over budget
});

test('aiBudgetLevel: a non-positive / invalid budget means "no budget" → always ok', () => {
  assert.equal(aiBudgetLevel(100, 0), 'ok');
  assert.equal(aiBudgetLevel(100, -1), 'ok');
  assert.equal(aiBudgetLevel(100, NaN), 'ok');
});

// ── ET month / day keys ───────────────────────────────────────────────────────
test('monthKey / dayKey use the business timezone (ET), not the server UTC day', () => {
  // Midday UTC on 2026-07-07 is 08:00 ET the same day.
  const midday = new Date('2026-07-07T12:00:00Z');
  assert.equal(monthKey(midday), '2026-07');
  assert.equal(dayKey(midday), '2026-07-07');

  // 2026-07-01T02:00:00Z is still 2026-06-30 22:00 in ET — the budget must not
  // roll into July an evening early. This is the whole reason we key on ET.
  const lateJune = new Date('2026-07-01T02:00:00Z');
  assert.equal(dayKey(lateJune), '2026-06-30');
  assert.equal(monthKey(lateJune), '2026-06');
});
