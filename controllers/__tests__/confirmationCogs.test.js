// controllers/__tests__/confirmationCogs.test.js
//
// Pure-logic checks for Order.computeConfirmationCogs — the confirmation-stage
// COGS estimate that supersedes the quote-stage one in the save hooks.
//
//   node --test controllers/__tests__/confirmationCogs.test.js
//
// The behavior under test (Nate's "est COGS shouldn't add up all the quotes"):
//   1. Once a confirmation exists, COGS = Σ (item qty × unitCost) over the
//      items the client actually ended up with — never the whole pitch.
//   2. A confirmation whose items carry NO unitCost (built before the field
//      existed) returns 0, so the hooks keep the quote-derived figure instead
//      of zeroing a real estimate.
//   3. Money snaps to cents — no float drift into the stored scalar.

const test = require('node:test');
const assert = require('node:assert/strict');

const Order = require('../../models/Order');
const { computeConfirmationCogs } = Order;

const item = (unitCost, qtys, over = {}) => ({
  description: 'Tee', unitCost,
  sizes: qtys.map((q) => ({ label: 'M', qty: q, unitPrice: 9.5 })),
  ...over,
});

test('sums qty × unitCost across items and sizes', () => {
  const conf = { items: [item(6.3, [24, 24]), item(11.05, [12])] };
  // 48 × 6.30 + 12 × 11.05 = 302.40 + 132.60 = 435.00
  assert.equal(computeConfirmationCogs(conf), 435);
});

test('ignores unitPrice entirely — the client price never leaks into COGS', () => {
  const conf = { items: [item(5, [10], { sizes: [{ label: 'M', qty: 10, unitPrice: 99 }] })] };
  assert.equal(computeConfirmationCogs(conf), 50);
});

test('legacy confirmation with no unitCost returns 0 (hooks keep the quote figure)', () => {
  const conf = { items: [item(0, [50]), item(undefined, [25])] };
  assert.equal(computeConfirmationCogs(conf), 0);
});

test('empty / missing confirmations are 0, never NaN', () => {
  assert.equal(computeConfirmationCogs(null), 0);
  assert.equal(computeConfirmationCogs({}), 0);
  assert.equal(computeConfirmationCogs({ items: [] }), 0);
  assert.equal(computeConfirmationCogs({ items: [{ unitCost: 3 }] }), 0, 'item with no sizes = 0 units');
});

test('snaps to cents — float unitCosts cannot drift the stored scalar', () => {
  // 3 × 6.3333 = 18.9999 → 19.00 (roundCents), not 18.999899999...
  const conf = { items: [item(6.3333, [3])] };
  assert.equal(computeConfirmationCogs(conf), 19);
});
