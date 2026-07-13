// controllers/__tests__/socialPosts.test.js
//
// Pure-logic checks for the Content planner's write path — the whitelist
// cleaner, the status→timestamp coupling, and stat-snapshot hygiene.
//
//   node --test controllers/__tests__/socialPosts.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanPostFields, applyStatusStamps, cleanStatSnapshot } = require('../socialPosts');

test('cleanPostFields whitelists — stray fields never reach the write', () => {
  const set = cleanPostFields({ title: 'Dispo tour recap', hacker: 'nope', $where: 'x' });
  assert.deepEqual(Object.keys(set), ['title']);
});

test('platform/status only accept vocabulary values', () => {
  assert.equal(cleanPostFields({ platform: 'Instagram' }).platform, 'instagram');
  assert.equal(cleanPostFields({ platform: 'linkedin' }).platform, '', 'LinkedIn dropped → unassigned');
  assert.equal(cleanPostFields({ platform: 'tiktok' }).platform, '', 'unknown platform → unassigned');
  assert.equal(cleanPostFields({ status: 'posted' }).status, 'posted');
  assert.equal(cleanPostFields({ status: 'yolo' }).status, undefined, 'unknown status is dropped');
});

test('postUrl requires http(s); refImage requires a data: URL', () => {
  assert.equal(cleanPostFields({ postUrl: 'javascript:alert(1)' }).postUrl, '');
  assert.equal(cleanPostFields({ postUrl: 'https://www.instagram.com/p/x' }).postUrl,
    'https://www.instagram.com/p/x');
  assert.equal(cleanPostFields({ refImage: 'https://evil/img.png' }).refImage, '');
  assert.equal(cleanPostFields({ refImage: 'data:image/jpeg;base64,abc' }).refImage,
    'data:image/jpeg;base64,abc');
});

test('flipping to posted stamps postedAt exactly once', () => {
  const now = new Date('2026-07-11T12:00:00Z');
  const first = applyStatusStamps({ status: 'posted' }, {}, now);
  assert.equal(first.postedAt, now, 'first post stamps the pace week');
  const again = applyStatusStamps({ status: 'posted' }, { postedAt: new Date('2026-07-01') }, now);
  assert.equal(again.postedAt, undefined, 'an existing postedAt is never overwritten');
  const explicit = applyStatusStamps({ status: 'posted', postedAt: new Date('2026-07-05') }, {}, now);
  assert.equal(+explicit.postedAt, +new Date('2026-07-05'), 'an explicit date wins');
});

test('archive stamps archivedAt; unarchive clears it — nothing ever deletes', () => {
  const now = new Date();
  assert.equal(applyStatusStamps({ archived: true }, { archived: false }, now).archivedAt, now);
  assert.equal(applyStatusStamps({ archived: false }, { archived: true }, now).archivedAt, null);
});

test('stat snapshots clamp garbage to 0 — the growth curve never dips on a typo', () => {
  const snap = cleanStatSnapshot({ views: '1200', likes: -3, comments: 'lots', shares: 4.6 });
  assert.equal(snap.views, 1200);
  assert.equal(snap.likes, 0);
  assert.equal(snap.comments, 0);
  assert.equal(snap.shares, 4.6);
  assert.ok(snap.at instanceof Date);
});
