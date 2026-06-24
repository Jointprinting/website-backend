// controllers/__tests__/approvalGate.test.js
//
// Pure-logic checks (no DB) for the client-approval hardening pass:
//
//   1. C1 strand-gate — a re-share/supersede must clear the previous cycle's
//      "options picked" gate, so a returning client is never stranded on the
//      "building your confirmation" interstitial. _pickedAtForCycle is the pure
//      predicate the public payload uses; this pins it against the supersede
//      cutoff. (The rotate/sendApprovalLink paths ALSO null optionsPickedAt at
//      write time; this gate is the read-side backstop for already-superseded
//      docs.)
//
//   2. Share guards (H3 + C2) — confirmationShareIssues rejects a $0 / no-priced
//      confirmation and an over-allocated multi-ship-to confirmation, while a
//      healthy one (and a legitimately deep-discounted one) passes.
//
//   node --test controllers/__tests__/approvalGate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { _pickedAtForCycle, _currentApprovalStatus } = require('../approval');
const { confirmationShareIssues } = require('../../models/Order');

// ── C1: pick gate is scoped to the current approval cycle ────────────────────
test('_pickedAtForCycle: pick with no supersede is reported', () => {
  const pickedAt = new Date('2026-06-01T12:00:00Z');
  assert.equal(
    +new Date(_pickedAtForCycle({ optionsPickedAt: pickedAt, approvalSupersededAt: null })),
    +pickedAt,
  );
});

test('_pickedAtForCycle: pick BEFORE a later supersede is dropped (strand fix)', () => {
  // The exact strand scenario: client picked, owner later re-shared (supersede),
  // pick is stale → must read as null so the page leaves the "building" gate.
  const order = {
    optionsPickedAt:      new Date('2026-06-01T12:00:00Z'),
    approvalSupersededAt: new Date('2026-06-10T09:00:00Z'),
  };
  assert.equal(_pickedAtForCycle(order), null);
});

test('_pickedAtForCycle: a fresh pick AFTER the supersede is kept', () => {
  const order = {
    approvalSupersededAt: new Date('2026-06-10T09:00:00Z'),
    optionsPickedAt:      new Date('2026-06-11T15:00:00Z'),
  };
  assert.notEqual(_pickedAtForCycle(order), null);
  assert.equal(+new Date(_pickedAtForCycle(order)), +order.optionsPickedAt);
});

test('_pickedAtForCycle: no pick at all → null', () => {
  assert.equal(_pickedAtForCycle({ approvalSupersededAt: new Date() }), null);
  assert.equal(_pickedAtForCycle({}), null);
  assert.equal(_pickedAtForCycle(null), null);
});

test('_currentApprovalStatus mirrors the same supersede cutoff (no contradiction)', () => {
  // An approval that predates the supersede is historical → status pending again,
  // exactly like the pick gate drops a pre-supersede pick. The two gates agree.
  const order = {
    approvalSupersededAt: new Date('2026-06-10T00:00:00Z'),
    approvalEvents: [
      { kind: 'approved', at: new Date('2026-06-01T00:00:00Z'), by: 'Sam' },
    ],
    optionsPickedAt: new Date('2026-06-01T00:00:00Z'),
  };
  assert.equal(_currentApprovalStatus(order).status, 'pending');
  assert.equal(_pickedAtForCycle(order), null);
});

// ── H3/C2: share guard ───────────────────────────────────────────────────────
const item = (qty, unitPrice, allocations) => ({
  sizes: [{ label: 'OS', qty, unitPrice }],
  ...(allocations ? { allocations } : {}),
});

test('share guard: empty confirmation surfaces NO issues (handled elsewhere)', () => {
  assert.deepEqual(confirmationShareIssues(null), []);
  assert.deepEqual(confirmationShareIssues({}), []);
  assert.deepEqual(confirmationShareIssues({ items: [], customLines: [] }), []);
});

test('share guard: a healthy priced confirmation passes', () => {
  const conf = { items: [item(50, 12)], customLines: [] };
  assert.deepEqual(confirmationShareIssues(conf), []);
});

test('share guard (H3): items present but $0 total is blocked', () => {
  // Items exist (so the confirmation has content) but every unit price is 0 →
  // grand total $0 → not a real order.
  const conf = { items: [item(50, 0), item(20, 0)], customLines: [] };
  const issues = confirmationShareIssues(conf);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /no priced line items|\$0/i);
});

test('share guard (H3): content is only an add-on line, no priced items → blocked', () => {
  // A customLine alone (e.g. a stray fee) makes hasConfirmationContent true, but
  // there are no priced items — must block, not ship a $0-merchandise doc.
  const conf = { items: [], customLines: [{ label: 'Shipping', amount: 25 }] };
  const issues = confirmationShareIssues(conf);
  assert.ok(issues.some(i => /no priced line items|\$0/i.test(i)));
});

test('share guard: a deep discount to a low (but >0, real-items) total still passes', () => {
  // 100 @ $10 = 1000, minus a 95% discount → $50. Real priced items + >$0 → OK.
  const conf = {
    items: [item(100, 10)],
    customLines: [{ label: 'Loyalty discount', amount: -95, isPercent: true }],
  };
  assert.deepEqual(confirmationShareIssues(conf), []);
});

test('share guard (C2): an over-allocated item is blocked', () => {
  // 100 units total, but 140 allocated across locations → broken split.
  const conf = {
    items: [{ productName: 'Tee', sizes: [{ label: 'OS', qty: 100, unitPrice: 10 }],
              allocations: [{ key: 'a', qty: 90 }, { key: 'b', qty: 50 }] }],
    shipTos: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
  };
  const issues = confirmationShareIssues(conf);
  assert.ok(issues.some(i => /over-allocated/i.test(i)), 'flags over-allocation');
  assert.ok(issues.some(i => /Tee/.test(i)), 'names the offending item');
});

test('share guard (C2): UNDER-allocation is allowed (Unassigned shown on client page)', () => {
  // 100 units, only 60 allocated → the remaining 40 render as "Unassigned" on the
  // client page; this is valid and must NOT block sharing.
  const conf = {
    items: [{ productName: 'Tee', sizes: [{ label: 'OS', qty: 100, unitPrice: 10 }],
              allocations: [{ key: 'a', qty: 60 }] }],
    shipTos: [{ key: 'a', label: 'A' }],
  };
  assert.deepEqual(confirmationShareIssues(conf), []);
});

test('share guard (C2): exact allocation passes', () => {
  const conf = {
    items: [{ productName: 'Tee', sizes: [{ label: 'OS', qty: 100, unitPrice: 10 }],
              allocations: [{ key: 'a', qty: 70 }, { key: 'b', qty: 30 }] }],
    shipTos: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }],
  };
  assert.deepEqual(confirmationShareIssues(conf), []);
});

test('share guard: no shipTos means allocations are ignored (single-location)', () => {
  // Stray allocations with no shipTos defined must not trip the over-alloc guard.
  const conf = {
    items: [{ productName: 'Tee', sizes: [{ label: 'OS', qty: 100, unitPrice: 10 }],
              allocations: [{ key: 'gone', qty: 999 }] }],
  };
  assert.deepEqual(confirmationShareIssues(conf), []);
});

test('share guard: a STALE allocation key (deleted shipTo) does not over-block', () => {
  // 100 units, 60 → existing 'a', 90 → 'b' which no longer exists in shipTos. The
  // assigned count must only sum live keys (60 ≤ 100) so this is NOT flagged —
  // matching the builder UI and the client "Unassigned" display exactly. (If the
  // server summed every allocation blindly it would wrongly 422 a fine share.)
  const conf = {
    items: [{ productName: 'Tee', sizes: [{ label: 'OS', qty: 100, unitPrice: 10 }],
              allocations: [{ key: 'a', qty: 60 }, { key: 'b', qty: 90 }] }],
    shipTos: [{ key: 'a', label: 'A' }],
  };
  assert.deepEqual(confirmationShareIssues(conf), []);
});
