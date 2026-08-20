// A question asked before the confirmation is published must not decide anything.
//
// "Ask a question" posted the same terminal `requested_changes` event at every
// stage. At the picker stage that flipped approvalStatus, which flipped the
// client's page out of the picker into the legacy summary — a table of EVERY
// option including the ones they never chose, under a Total that summed all of
// them. Asking "does this come in green?" replaced their quote with a wildly
// inflated number and no way back; only the owner re-sharing could undo it.
//
// Pre-confirmation the controller now records kind:'question' instead. These pin
// the two properties that makes safe: 'question' is not terminal, and
// _confPublished is the predicate the controller branches on.

const test = require('node:test');
const assert = require('node:assert/strict');

const { _currentApprovalStatus, _confPublished } = require('../approval');

const at = (iso) => new Date(iso);

test("a 'question' event leaves the approval pending — it decides nothing", () => {
  const order = {
    approvalEvents: [
      { kind: 'viewed',   at: at('2026-08-01T10:00:00Z') },
      { kind: 'question', at: at('2026-08-01T10:05:00Z'), message: 'does this come in green?' },
    ],
  };
  const cur = _currentApprovalStatus(order);
  assert.equal(cur.status, 'pending', 'the client keeps their picker and their quote');
  assert.equal(cur.at, null);
});

test('several questions in a row still decide nothing', () => {
  const order = {
    approvalEvents: [
      { kind: 'question', at: at('2026-08-01T10:00:00Z'), message: 'green?' },
      { kind: 'question', at: at('2026-08-01T11:00:00Z'), message: 'and hoodies?' },
      { kind: 'question', at: at('2026-08-02T09:00:00Z'), message: 'timeline?' },
    ],
  };
  assert.equal(_currentApprovalStatus(order).status, 'pending');
});

test("post-confirmation 'requested_changes' is still terminal — unchanged", () => {
  const order = {
    approvalEvents: [
      { kind: 'question',          at: at('2026-08-01T10:00:00Z') },
      { kind: 'requested_changes', at: at('2026-08-03T10:00:00Z'), message: 'swap the back print', by: 'Jay' },
    ],
  };
  const cur = _currentApprovalStatus(order);
  assert.equal(cur.status, 'requested_changes');
  assert.equal(cur.by, 'Jay');
});

test('a question does not shadow an approval that came before it', () => {
  const order = {
    approvalEvents: [
      { kind: 'approved', at: at('2026-08-01T10:00:00Z'), by: 'Rita' },
      { kind: 'question', at: at('2026-08-01T12:00:00Z'), message: 'when does it ship?' },
    ],
  };
  assert.equal(_currentApprovalStatus(order).status, 'approved');
});

test('_confPublished is the branch: unpublished = question, published = decision', () => {
  // No confirmation at all, or one still in draft → the client is at the picker.
  assert.equal(_confPublished(null), false);
  assert.equal(_confPublished({ items: [], publishedAt: null }), false);
  assert.equal(_confPublished({ items: [{ productName: 'Tee' }], publishedAt: null }), false);
  // Published → the client is reviewing a real confirmation, so notes decide.
  assert.equal(_confPublished({ items: [{ productName: 'Tee' }], publishedAt: new Date() }), true);
});
