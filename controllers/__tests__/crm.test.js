// controllers/__tests__/crm.test.js
//
// Pure-logic checks for the CRM pipeline math (no DB). Runs on Node's built-in
// test runner — no extra dev deps:
//
//   node --test controllers/__tests__/crm.test.js
//
// summarizePipeline / stageProbability are exported from controllers/crm.js and
// take plain { stage, dealValue } POJOs, so they're testable without Mongo.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizePipeline,
  stageProbability,
  STAGE_PROBABILITY,
} = require('../crm');

// ── Probability map ──────────────────────────────────────────────────────────
test('STAGE_PROBABILITY uses the agreed close-rates', () => {
  assert.equal(STAGE_PROBABILITY.lead,      0.1);
  assert.equal(STAGE_PROBABILITY.contacted, 0.25);
  assert.equal(STAGE_PROBABILITY.quoting,   0.5);
  assert.equal(STAGE_PROBABILITY.sampling,  0.7);
  assert.equal(STAGE_PROBABILITY.won,       1);
  assert.equal(STAGE_PROBABILITY.customer,  1);
  assert.equal(STAGE_PROBABILITY.lost,      0);
  assert.equal(STAGE_PROBABILITY.dormant,   0);
});

test('stageProbability falls back to 0 for unknown stages', () => {
  assert.equal(stageProbability('lead'),     0.1);
  assert.equal(stageProbability('nonsense'), 0);
  assert.equal(stageProbability(undefined),  0);
  assert.equal(stageProbability(''),         0);
});

// ── summarizePipeline ────────────────────────────────────────────────────────
test('empty / missing input yields zeroes', () => {
  assert.deepEqual(summarizePipeline([]),        { totalOpenValue: 0, weightedValue: 0 });
  assert.deepEqual(summarizePipeline(undefined), { totalOpenValue: 0, weightedValue: 0 });
  assert.deepEqual(summarizePipeline(null),      { totalOpenValue: 0, weightedValue: 0 });
});

test('totalOpenValue counts only open stages; weightedValue weights every stage', () => {
  const records = [
    { stage: 'lead',      dealValue: 1000 },  // open · weight 0.1  → 100
    { stage: 'contacted', dealValue: 2000 },  // open · weight 0.25 → 500
    { stage: 'quoting',   dealValue: 4000 },  // open · weight 0.5  → 2000
    { stage: 'sampling',  dealValue: 1000 },  // open · weight 0.7  → 700
    { stage: 'won',       dealValue: 5000 },  // CLOSED · weight 1   → 5000
    { stage: 'customer',  dealValue: 3000 },  // CLOSED · weight 1   → 3000
    { stage: 'lost',      dealValue: 9999 },  // CLOSED · weight 0   → 0
    { stage: 'dormant',   dealValue: 8888 },  // CLOSED · weight 0   → 0
  ];

  // Open = lead + contacted + quoting + sampling (won/customer/lost/dormant excluded)
  const expectedOpen = 1000 + 2000 + 4000 + 1000; // 8000
  // Weighted = 100 + 500 + 2000 + 700 + 5000 + 3000 + 0 + 0
  const expectedWeighted = 100 + 500 + 2000 + 700 + 5000 + 3000; // 11300

  const out = summarizePipeline(records);
  assert.equal(out.totalOpenValue, expectedOpen);
  assert.equal(out.weightedValue,  expectedWeighted);
});

test('non-numeric / missing dealValue is treated as 0', () => {
  const records = [
    { stage: 'quoting', dealValue: '2000' },   // numeric string → 1000 weighted
    { stage: 'quoting' },                       // missing → 0
    { stage: 'quoting', dealValue: null },      // null → 0
    { stage: 'quoting', dealValue: undefined }, // undefined → 0
  ];
  const out = summarizePipeline(records);
  assert.equal(out.totalOpenValue, 2000);  // only the '2000' record counts
  assert.equal(out.weightedValue,  1000);  // 2000 × 0.5
});

test('fractional weighting rounds to cents (no float drift)', () => {
  // 333.33 at quoting (0.5) = 166.665 → rounds to 166.67 (round-half-up on .665)
  const out = summarizePipeline([{ stage: 'quoting', dealValue: 333.33 }]);
  assert.equal(out.totalOpenValue, 333.33);
  assert.equal(out.weightedValue,  166.67);
});
