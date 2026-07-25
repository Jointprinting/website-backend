// The "next project #" the UI pre-fills used to disagree with the number the
// server would actually assign.
//
// GET /api/orders/next-numbers scanned the whole orders collection and returned
// max+1. But numbers are assigned from the ATOMIC COUNTER (utils/sequence), and
// bumpCounterTo pushes that counter past any number the owner types by hand. So
// after manually creating project #200 with a document max of #150, the preview
// said "151" while the server would really hand out "201".
//
// peekNumber is the function that answers exactly what nextNumber WOULD claim,
// without consuming it. These pin the shared math both sides run on, so the
// preview and the assignment cannot drift apart again.

const test = require('node:test');
const assert = require('node:assert');

const { _flooredNext, _flooredSeq, _numOf } = require('../sequence');

test('the preview is the counter + 1, not the document max + 1', () => {
  // The counter is at 200 because the owner hand-typed #200 and bumpCounterTo
  // carried it. The next number is 201 — regardless of what the documents say.
  assert.strictEqual(_flooredNext(200), 201);
});

test('a fresh counter starts at 1', () => {
  assert.strictEqual(_flooredNext(0), 1);
});

test('an owner-set floor wins while it is ahead of the counter', () => {
  // Heritage's real PO run reached #8 in Drive, invisible to a counter that only
  // ever saw #4. The floor is what makes the next one #009 rather than #005.
  assert.strictEqual(_flooredNext(4, 9), 9);
});

test('once the counter passes the floor, the counter wins', () => {
  assert.strictEqual(_flooredNext(12, 9), 13);
});

test('no floor behaves exactly as before', () => {
  assert.strictEqual(_flooredNext(7), 8);
  assert.strictEqual(_flooredNext(7, 0), 8);
  assert.strictEqual(_flooredNext(7, null), 8);
});

test('numOf reads the numeric prefix the same way the scan used to', () => {
  // The old scan split on '-' and parsed; the counter uses numOf. They must
  // agree on every real shape or seeding a counter from the max would drift.
  assert.strictEqual(_numOf('135'), 135);
  assert.strictEqual(_numOf('22-1'), 22);
  assert.strictEqual(_numOf('22-2'), 22);
  assert.strictEqual(_numOf('#007'), 7);
  assert.strictEqual(_numOf(''), 0);
  assert.strictEqual(_numOf(null), 0);
  assert.strictEqual(_numOf(undefined), 0);
});

test('a sub-numbered project does not inflate the sequence', () => {
  // #22-2 must not make the next project #23 skip ahead — it is still job 22.
  assert.strictEqual(_flooredSeq(_numOf('22-2')), _flooredSeq(22));
});
