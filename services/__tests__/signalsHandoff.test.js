// The two moments where the ball lands in the OWNER's court — and the hub said
// nothing about either.
//
//   1. A client picked their options on the approval link. They've done their
//      part and are waiting on a confirmation to approve. Nothing in the signals
//      service read optionsPickedAt at all, so the only way to find out was to
//      go looking.
//   2. A preorder drop cleared its MOQ. That IS the moment the run is a go and
//      the tally becomes a real order. PreorderLink was never queried.
//
// Both must SELF-CLEAR when the work is done, or they become noise the owner
// learns to ignore — which is worse than no signal at all.

const test = require('node:test');
const assert = require('node:assert');

const { bucketAwaitingConfirmation, bucketPreorderDrops } = require('../signals');

const NOW = new Date('2026-07-25T12:00:00Z');

// The real predicates, so these tests break if either changes underneath.
const { _pickedAtForCycle } = require('../../controllers/approval');
const { confirmationIsPublished } = require('../../models/Order');
const bucket = (orders, now = NOW) =>
  bucketAwaitingConfirmation(orders, _pickedAtForCycle, confirmationIsPublished, now);

const order = (over = {}) => ({
  _id: 'o1', orderNumber: '44', projectNumber: '000150', companyKey: 'happyleafdispensary',
  companyName: 'Happy Leaf Dispensary',
  optionsPickedAt: new Date('2026-07-23T09:00:00Z'),
  approvalSupersededAt: null,
  confirmation: {},
  ...over,
});

// ── 1. Client picked, confirmation owed ─────────────────────────────────────

test('a client who picked and has no confirmation is surfaced', () => {
  const out = bucket([order()]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'Happy Leaf Dispensary');
  assert.strictEqual(out[0].metric, '2d', 'how long they have been waiting');
  assert.strictEqual(out[0].orderNumber, '44', 'carries the deep-link keys');
  assert.strictEqual(out[0].projectNumber, '000150');
});

test('an order where nobody picked is not surfaced', () => {
  assert.deepStrictEqual(bucket([order({ optionsPickedAt: null })]), []);
});

test('publishing the confirmation CLEARS it — the ball is back with the client', () => {
  const out = bucket([order({
    confirmation: {
      items: [{ sizes: [{ qty: 12 }] }],
      publishedAt: new Date('2026-07-24T10:00:00Z'),   // after the picks
    },
  })]);
  assert.deepStrictEqual(out, [], 'the signal must self-clear once the work is done');
});

test('a confirmation published BEFORE the picks does not clear them', () => {
  // The trap: an old confirmation exists, then the client re-picks. That's new
  // work owed, not finished work.
  const out = bucket([order({
    confirmation: {
      items: [{ sizes: [{ qty: 12 }] }],
      publishedAt: new Date('2026-07-01T10:00:00Z'),   // before the picks
    },
  })]);
  assert.strictEqual(out.length, 1);
});

test('a draft confirmation with content but never published still owes work', () => {
  // confirmationIsPublished is the gate — content alone is not enough.
  const out = bucket([order({ confirmation: { items: [{ sizes: [{ qty: 12 }] }], publishedAt: null } })]);
  assert.strictEqual(out.length, 1);
});

test('picks from a SUPERSEDED approval cycle are stale and ignored', () => {
  // The owner re-shared with a fresh ask; the old picks no longer mean anything.
  const out = bucket([order({
    optionsPickedAt: new Date('2026-07-01T09:00:00Z'),
    approvalSupersededAt: new Date('2026-07-10T09:00:00Z'),
  })]);
  assert.deepStrictEqual(out, []);
});

test('picks NEWER than the supersede mark are live', () => {
  const out = bucket([order({
    approvalSupersededAt: new Date('2026-07-20T09:00:00Z'),
    optionsPickedAt: new Date('2026-07-23T09:00:00Z'),
  })]);
  assert.strictEqual(out.length, 1);
});

test('the longest wait ranks first', () => {
  const out = bucket([
    order({ _id: 'fresh', orderNumber: '2', companyName: 'Fresh', optionsPickedAt: new Date('2026-07-25T09:00:00Z') }),
    order({ _id: 'old', orderNumber: '1', companyName: 'Old', optionsPickedAt: new Date('2026-07-15T09:00:00Z') }),
  ]);
  assert.strictEqual(out[0].name, 'Old');
});

test('picked today reads as "today", not "0d"', () => {
  const out = bucket([order({ optionsPickedAt: new Date('2026-07-25T08:00:00Z') })]);
  assert.strictEqual(out[0].metric, 'today');
});

test('handles empty and missing input', () => {
  assert.deepStrictEqual(bucket([]), []);
  assert.deepStrictEqual(bucket(undefined), []);
});

// ── 2. Preorder drops that cleared their minimum ────────────────────────────

const link = (over = {}) => ({
  _id: 'p1', title: 'Fall Hoodie Drop', companyKey: 'happyleafdispensary', projectNumber: '000150',
  moq: 24, expiresAt: null, revokedAt: null, orderId: null,
  commitments: [{ qty: 12 }, { qty: 18 }],   // 30 ≥ 24
  ...over,
});

test('a drop past its minimum is surfaced with the tally', () => {
  const out = bucketPreorderDrops([link()], NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].name, 'Fall Hoodie Drop');
  assert.strictEqual(out[0].metric, '30/24');
});

test('a drop still short of its minimum is not surfaced', () => {
  assert.deepStrictEqual(bucketPreorderDrops([link({ commitments: [{ qty: 5 }] })], NOW), []);
});

test('exactly AT the minimum counts — that is a go', () => {
  const out = bucketPreorderDrops([link({ moq: 30 })], NOW);
  assert.strictEqual(out.length, 1);
});

test('a drop already turned into an order CLEARS', () => {
  assert.deepStrictEqual(bucketPreorderDrops([link({ orderId: 'ord1' })], NOW), [],
    'linking it to an order is the work — it must stop nagging');
});

test('a revoked drop clears — the door is shut', () => {
  assert.deepStrictEqual(bucketPreorderDrops([link({ revokedAt: new Date('2026-07-20') })], NOW), []);
});

test('an expired drop clears', () => {
  assert.deepStrictEqual(bucketPreorderDrops([link({ expiresAt: new Date('2026-07-01') })], NOW), []);
});

test('a drop expiring in the FUTURE is still live', () => {
  const out = bucketPreorderDrops([link({ expiresAt: new Date('2026-08-30') })], NOW);
  assert.strictEqual(out.length, 1);
});

test('an open tally with no MOQ is never "a go"', () => {
  // moq 0 means the owner wanted a running count, not a threshold.
  assert.deepStrictEqual(bucketPreorderDrops([link({ moq: 0 })], NOW), []);
});

test('the biggest overshoot ranks first', () => {
  const out = bucketPreorderDrops([
    link({ _id: 'small', title: 'Small', moq: 10, commitments: [{ qty: 11 }] }),
    link({ _id: 'big', title: 'Big', moq: 10, commitments: [{ qty: 90 }] }),
  ], NOW);
  assert.strictEqual(out[0].name, 'Big');
});

test('bad commitment rows do not poison the tally', () => {
  const out = bucketPreorderDrops([link({ commitments: [{ qty: 30 }, null, { qty: 'x' }] })], NOW);
  assert.strictEqual(out[0].metric, '30/24');
});

test('handles empty and missing input', () => {
  assert.deepStrictEqual(bucketPreorderDrops([], NOW), []);
  assert.deepStrictEqual(bucketPreorderDrops(undefined, NOW), []);
});
