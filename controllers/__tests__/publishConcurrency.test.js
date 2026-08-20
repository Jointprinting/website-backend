// controllers/__tests__/publishConcurrency.test.js
//
//   node --test controllers/__tests__/publishConcurrency.test.js
//
// "Push to client" used to read the order, mutate it, and save() with a
// markModified('confirmation') — which forces Mongoose to $set the WHOLE
// confirmation subdocument as it was read. Both builders autosave 800ms after a
// keystroke with no Save button, so an autosave landing between that read and
// that write was silently reverted, and the reverted confirmation is what went
// live to the client. Of every read-modify-write in this codebase, that is the
// one whose loser is a customer-facing document.
//
// The write is now dotted paths and a $push. These pin that shape, because the
// failure it prevents is invisible in a single-tab test — it only shows up as a
// client seeing a document the owner already corrected.

const test = require('node:test');
const assert = require('node:assert/strict');

const { _publishUpdate } = require('../approval');

const NOW = new Date('2026-08-20T12:00:00Z');

test('the confirmation is never written as a whole subdocument', () => {
  const u = _publishUpdate(NOW, false);
  assert.equal('confirmation' in u.$set, false, 'a whole-subdocument $set reverts a concurrent autosave');
  assert.deepEqual(u.$set['confirmation.publishedAt'], NOW);
});

test('the activity log is appended, never replaced', () => {
  const u = _publishUpdate(NOW, false);
  assert.equal('activity' in u.$set, false, 'a whole-array $set drops entries written since the read');
  assert.equal(u.$push.activity.kind, 'confirmation_pushed');
  assert.equal(u.$push.activity.actor, 'admin');
  assert.deepEqual(u.$push.activity.at, NOW);
});

test('publishing touches nothing but the fields publishing owns', () => {
  const u = _publishUpdate(NOW, false);
  assert.deepEqual(Object.keys(u.$set), ['confirmation.publishedAt']);
  assert.deepEqual(Object.keys(u), ['$set', '$push']);
});

test('a re-push after a change request reopens the cycle on the same link', () => {
  const u = _publishUpdate(NOW, true);
  assert.deepEqual(u.$set.approvalSupersededAt, NOW);
  assert.equal(u.$push.activity.message, 'Pushed revised confirmation to the client');
  assert.equal(u.$push.activity.meta.reopened, true);
  // Still no whole-subdocument write on the reopen path.
  assert.equal('confirmation' in u.$set, false);
});

test('a first push does not supersede anything', () => {
  const u = _publishUpdate(NOW, false);
  assert.equal('approvalSupersededAt' in u.$set, false);
  assert.equal(u.$push.activity.message, 'Pushed confirmation to the client');
  assert.equal(u.$push.activity.meta.reopened, false);
});
