// services/__tests__/instagramSync.test.js
//
// Pure-logic checks for the Instagram sync's join + snapshot hygiene.
//
//   node --test services/__tests__/instagramSync.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePostUrl, shouldSnapshot } = require('../instagramSync');

test('permalink and pasted URL normalize to the same key', () => {
  const a = normalizePostUrl('https://www.instagram.com/p/C8xYz12AbCd/');
  const b = normalizePostUrl('https://instagram.com/p/C8xYz12AbCd');
  const c = normalizePostUrl('https://www.instagram.com/p/C8xYz12AbCd/?igsh=abc123&utm_source=share');
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(a, 'instagram.com/p/c8xyz12abcd');
});

test('different posts stay different; garbage is empty', () => {
  assert.notEqual(normalizePostUrl('https://instagram.com/p/AAA/'), normalizePostUrl('https://instagram.com/p/BBB/'));
  assert.equal(normalizePostUrl('not a url'), '');
  assert.equal(normalizePostUrl(''), '');
});

test('a moved number snapshots; an unchanged one waits a week', () => {
  const now = new Date('2026-07-11T12:00:00Z');
  const fresh = { at: new Date('2026-07-10T12:00:00Z'), views: 100, likes: 10, comments: 2 };
  assert.equal(shouldSnapshot(fresh, { views: 100, likes: 10, comments: 2 }, now), false, 'nothing moved, only a day old');
  assert.equal(shouldSnapshot(fresh, { views: 101, likes: 10, comments: 2 }, now), true, 'views moved');
  const stale = { ...fresh, at: new Date('2026-07-01T12:00:00Z') };
  assert.equal(shouldSnapshot(stale, { views: 100, likes: 10, comments: 2 }, now), true, 'flat but a week stale');
  assert.equal(shouldSnapshot(null, { views: 0, likes: 0, comments: 0 }, now), true, 'first reading always lands');
});
