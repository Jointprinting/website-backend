// controllers/__tests__/orderRevision.test.js
//
//   node --test controllers/__tests__/orderRevision.test.js
//
// PUT /api/orders/:id does `$set: {...body}`, and both builders send the ENTIRE
// quoteLines[] / confirmation subtree on every autosave — 800ms after a
// keystroke, with no Save button. So two tabs on one project overwrite each
// other in about ninety seconds of ordinary use:
//
//   Correct a size 24 → 36 on the iPad; it PUTs its whole confirmation. Add a
//   $250 rush line on the desktop; it PUTs ITS snapshot, where item 4 is still
//   24. The size correction is gone — silently, with no conflict and no audit
//   event. 24 shirts ship instead of 36.
//
// These pin the four properties the guard has to have to be both correct and
// safe to turn on mid-flight.

const test = require('node:test');
const assert = require('node:assert/strict');

const { planRevisionGuard, conflictPayload } = require('../../utils/orderRevision');

test('a writer that sends its base revision may only land on that revision', () => {
  const body = { confirmation: { items: [] }, baseConfirmationRev: 4 };
  const { filter, inc } = planRevisionGuard(body);
  assert.deepEqual(filter, { confirmationRev: 4 });
  assert.deepEqual(inc, { confirmationRev: 1 });
});

test('a document written before the counters existed is revision 0, with no backfill', () => {
  // Legacy orders carry no counter field at all. `{confirmationRev: 0}` would
  // not match a missing field, so every one of them would 409 on its first
  // save — which is exactly how a guard like this gets switched off.
  const { filter } = planRevisionGuard({ confirmation: { items: [] }, baseConfirmationRev: 0 });
  assert.deepEqual(filter, { confirmationRev: { $in: [0, null] } });
});

test('a writer that sends no base gets exactly the old behaviour', () => {
  // The agent portal, the scripts and apps-script all PUT without this — opt-in
  // per request, never a new protocol they have to learn.
  const { filter, inc } = planRevisionGuard({ confirmation: { items: [] } });
  assert.deepEqual(filter, {}, 'no precondition');
  assert.deepEqual(inc, { confirmationRev: 1 }, 'but the write is still a new revision');
});

test('the guard is per subtree, so a background write cannot invalidate an open editor', () => {
  // A UPS tick, a publish or a status change from the board bumps neither
  // counter, and a quote save must not conflict on the confirmation.
  const { filter, inc, guarded } = planRevisionGuard({
    quoteLines: [{ qty: 10 }], baseQuoteLinesRev: 2, baseConfirmationRev: 9,
  });
  assert.deepEqual(guarded, ['quoteLines']);
  assert.deepEqual(filter, { quoteLinesRev: 2 });
  assert.deepEqual(inc, { quoteLinesRev: 1 }, 'the untouched subtree is not bumped');
});

test('both subtrees in one write are each guarded and each bumped', () => {
  const { filter, inc } = planRevisionGuard({
    confirmation: { items: [] }, baseConfirmationRev: 1,
    quoteLines: [], baseQuoteLinesRev: 5,
  });
  assert.deepEqual(filter, { confirmationRev: 1, quoteLinesRev: 5 });
  assert.deepEqual(inc, { confirmationRev: 1, quoteLinesRev: 1 });
});

test('control fields never reach $set, and a counter is never client-writable', () => {
  // If a stale tab could write its own revision number it would hand itself a
  // free pass past the precondition on the very next save.
  const body = {
    confirmation: { items: [] }, baseConfirmationRev: 3,
    quoteLines: [], baseQuoteLinesRev: 1,
    confirmationRev: 999, quoteLinesRev: 999,
    companyName: 'Bleu Leaf',
  };
  planRevisionGuard(body);
  assert.deepEqual(Object.keys(body).sort(), ['companyName', 'confirmation', 'quoteLines']);
});

test('an explicit overwrite drops the precondition but still counts as a revision', () => {
  const body = { confirmation: { items: [] }, baseConfirmationRev: 1, forceOverwrite: true };
  const { filter, inc } = planRevisionGuard(body);
  assert.deepEqual(filter, {}, 'the owner chose to overwrite');
  assert.deepEqual(inc, { confirmationRev: 1 });
  assert.equal('forceOverwrite' in body, false, 'and it is not a field on the order');
});

test('a garbage base is treated as no base, never as revision 0', () => {
  // Revision 0 is a real revision. Coercing junk into it would let a broken
  // client overwrite a live document under a precondition that looks satisfied.
  for (const bad of ['', null, undefined, 'abc', NaN, -1]) {
    const { filter } = planRevisionGuard({ confirmation: {}, baseConfirmationRev: bad });
    assert.deepEqual(filter, {}, `base ${String(bad)} should not become a precondition`);
  }
});

test('a numeric string base still guards — form values arrive as strings', () => {
  const { filter } = planRevisionGuard({ quoteLines: [], baseQuoteLinesRev: '6' });
  assert.deepEqual(filter, { quoteLinesRev: 6 });
});

test('the conflict response names which subtree moved and where it is now', () => {
  const payload = conflictPayload(
    { confirmationRev: 5, quoteLinesRev: 2 },
    { confirmationRev: 4, quoteLinesRev: 2 },
  );
  assert.equal(payload.reason, 'conflict');
  assert.deepEqual(payload.conflicted, ['confirmationRev'], 'the quote lines did not move');
  assert.deepEqual(payload.revs, { confirmationRev: 5, quoteLinesRev: 2 });
});

test('a legacy order with no counters reports revision 0, not undefined', () => {
  const payload = conflictPayload({}, { confirmationRev: 1 });
  assert.deepEqual(payload.revs, { confirmationRev: 0, quoteLinesRev: 0 });
  assert.deepEqual(payload.conflicted, ['confirmationRev']);
});
