// controllers/__tests__/purchaseOrders.test.js
//
// Pure-logic checks for the PO charge-label cost parser (no DB). Runs on Node's
// built-in test runner — no extra dev deps:
//
//   node --test controllers/__tests__/purchaseOrders.test.js
//
// parseUnitCost is exported from controllers/purchaseOrders.js and takes a plain
// string, so it's testable without Mongo. It feeds the PO builder's "recent
// costs" panel (GET /api/orders/po-cost-history), pulling the per-unit dollar
// figure out of a charge label like "Tee: $2.40/unit * 25 units" -> 2.4. These
// tests PIN that behavior so the panel's unit-cost column can't silently drift.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseUnitCost } = require('../purchaseOrders');

// ── the canonical seeded shape ───────────────────────────────────────────────
test('pulls the per-unit figure from a standard charge label', () => {
  assert.equal(parseUnitCost('Tee: $2.40/unit * 25 units'), 2.4);
  assert.equal(parseUnitCost('Run Charge: $2.40/unit * 25 units'), 2.4);
});

// ── tolerances: commas, spacing, singular/plural, missing "$" ─────────────────
test('tolerates thousands commas', () => {
  assert.equal(parseUnitCost('Embroidered jacket: $1,234.50/unit * 10 units'), 1234.5);
  assert.equal(parseUnitCost('$1,000/unit'), 1000);
});

test('tolerates a space around the slash and either side of "unit"', () => {
  assert.equal(parseUnitCost('$2.40 /unit * 25 units'), 2.4);
  assert.equal(parseUnitCost('$2.40/ unit'), 2.4);
  assert.equal(parseUnitCost('$2.40 / unit'), 2.4);
});

test('accepts singular and plural unit(s)', () => {
  assert.equal(parseUnitCost('$3/unit'), 3);
  assert.equal(parseUnitCost('$3/units'), 3);
});

test('does not require a leading "$"', () => {
  assert.equal(parseUnitCost('2.40/unit * 25 units'), 2.4);
});

test('handles whole-dollar and fractional-cent figures', () => {
  assert.equal(parseUnitCost('Setup blanks: $12/unit * 50 units'), 12);
  assert.equal(parseUnitCost('$0.075/unit'), 0.075);
});

// ── absence -> null ──────────────────────────────────────────────────────────
test('returns null when there is no per-unit figure', () => {
  assert.equal(parseUnitCost('Item set-up fee'), null);
  assert.equal(parseUnitCost('Flat rush charge $50'), null);
  assert.equal(parseUnitCost('Freight'), null);
  assert.equal(parseUnitCost(''), null);
  assert.equal(parseUnitCost(null), null);
  assert.equal(parseUnitCost(undefined), null);
});

test('does not match "unit" without a number/slash (e.g. prose)', () => {
  assert.equal(parseUnitCost('Per unit pricing TBD'), null);
  assert.equal(parseUnitCost('25 units total'), null);
});

// ── first per-unit figure wins when a label is unusual ───────────────────────
test('takes the figure attached to /unit, not other dollar amounts', () => {
  // "$60" is the line total, "$2.40/unit" is the per-unit — we want 2.4.
  assert.equal(parseUnitCost('Run Charge $60: $2.40/unit * 25 units'), 2.4);
});
