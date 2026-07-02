// controllers/__tests__/sequence.test.js
//
// Order / project / PO number assignment (utils/sequence.js). The atomic $inc that
// hands out a number needs a live counter doc, so it isn't unit-tested here; what we
// CAN pin without a DB is the pure numbering math the assignment is built on — and
// that math is where an off-by-one would wrongly reuse or skip a business number:
//   • numOf   — parse the numeric part of any stored id ("22-1", "#009", 135)
//   • counterId — the per-vendor counter identity POs are numbered on
//   • flooredNext / flooredSeq — the owner-floor rule + the invariant that a peeked
//     "next number" equals exactly what the next $inc will assign.
//
//   node --test controllers/__tests__/sequence.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  _numOf, _slug, _counterId, _flooredNext, _flooredSeq,
} = require('../../utils/sequence');

// ── numOf: numeric prefix of a stored number ───────────────────────────────────
test('numOf reads the numeric prefix of any stored order/PO number', () => {
  assert.equal(_numOf('135'), 135);
  assert.equal(_numOf('22-1'), 22);      // project numbers can be "<n>-<seq>"
  assert.equal(_numOf('#007'), 7);       // PO numbers are zero-padded with a leading #
  assert.equal(_numOf('#009'), 9);
  assert.equal(_numOf(42), 42);          // already numeric
  assert.equal(_numOf(''), 0);
  assert.equal(_numOf(null), 0);
  assert.equal(_numOf(undefined), 0);
  assert.equal(_numOf('abc'), 0);        // non-numeric → 0 (never NaN)
});

// ── slug / vendorKey: the normalized per-vendor key ────────────────────────────
test('slug normalizes a vendor name (trim + collapse whitespace + lowercase)', () => {
  assert.equal(_slug('Heritage Screen Printing'), 'heritage screen printing');
  assert.equal(_slug('  Heritage   Screen  Printing  '), 'heritage screen printing');
  assert.equal(_slug(''), '');
  assert.equal(_slug(null), '');
  assert.equal(_slug(undefined), '');
});

// ── counterId: which counter a number is drawn from ────────────────────────────
test('counterId keeps project/invoice global and scopes POs per vendor', () => {
  assert.equal(_counterId('project'), 'project');
  assert.equal(_counterId('invoice'), 'invoice');
  assert.equal(_counterId('project', undefined), 'project');
  // POs get their own sequence per printer, keyed on the SAME normalized vendor key.
  assert.equal(_counterId('po', 'Heritage Press'), 'po:heritage press');
  assert.equal(_counterId('po', '  Heritage   Press '), 'po:heritage press');
  // Empty / missing scope → the shared 'po' counter (a vendorless draft still numbers).
  assert.equal(_counterId('po', ''), 'po');
  assert.equal(_counterId('po', null), 'po');
});

// ── flooredNext: the number that WOULD be assigned next ────────────────────────
test('flooredNext = max(seq + 1, owner floor)', () => {
  assert.equal(_flooredNext(4, 0), 5);          // no floor → natural next
  assert.equal(_flooredNext(4, undefined), 5);
  assert.equal(_flooredNext(0, 0), 1);          // brand-new counter → 1
  assert.equal(_flooredNext(4, 9), 9);          // owner floor lifts a low counter
  assert.equal(_flooredNext(8, 9), 9);
  assert.equal(_flooredNext(10, 9), 11);        // counter already past the floor
});

// ── flooredSeq: counter value to store so the next $inc yields the floor ────────
test('flooredSeq lifts the stored seq to floor-1 but never moves it backward', () => {
  assert.equal(_flooredSeq(4, 9), 8);           // next $inc → 9
  assert.equal(_flooredSeq(10, 9), 10);         // already ahead → unchanged
  assert.equal(_flooredSeq(4, 0), 4);           // no floor → unchanged
  assert.equal(_flooredSeq(4, undefined), 4);
});

// ── The load-bearing invariant: peek == what the next $inc assigns ─────────────
test('flooredSeq(seq, floor) + 1 always equals flooredNext(seq, floor)', () => {
  for (const seq of [0, 1, 4, 8, 10, 137]) {
    for (const floor of [0, 1, 9, 200, undefined]) {
      assert.equal(
        _flooredSeq(seq, floor) + 1,
        _flooredNext(seq, floor),
        `mismatch for seq=${seq} floor=${floor}`,
      );
    }
  }
});
