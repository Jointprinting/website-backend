// services/__tests__/outreachContent.test.js
//
// Pure content helpers (spintax) behind the cold-outreach sender. Deterministic,
// so a preview / retry / real send resolve a spin the same way for the same
// recipient — unit-tested without a DB.
//
//   node --test services/__tests__/outreachContent.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { hashStr, applySpintax, hasSpintax } = require('../outreachContent');

test('applySpintax picks one option per {a|b|c} group', () => {
  const out = applySpintax('{Hi|Hey|Hello} there', 'seedX');
  assert.ok(['Hi there', 'Hey there', 'Hello there'].includes(out));
});

test('applySpintax is deterministic for the same seed, varies across seeds', () => {
  const a = applySpintax('{one|two|three|four|five}', 'buyer-A');
  const b = applySpintax('{one|two|three|four|five}', 'buyer-A');
  assert.equal(a, b); // same recipient → same variant every render
  // Across many seeds we should see more than one distinct choice.
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(applySpintax('{one|two|three|four|five}', `buyer-${i}`));
  assert.ok(seen.size > 1, 'different recipients should get different variants');
});

test('applySpintax resolves multiple groups independently', () => {
  const out = applySpintax('{A|B} and {C|D}', 'seed');
  assert.match(out, /^[AB] and [CD]$/);
});

test('applySpintax NEVER corrupts a {{merge|fallback}} token', () => {
  // Post-merge there are no braces, but even if a stray {{x|y}} slips through,
  // the single-brace spin pattern must not chew the inner {x|y}.
  const tpl = 'in {{city|your area}} today';
  const out = applySpintax(tpl, 'seed');
  assert.equal(out, tpl); // untouched — double-brace tokens are not spin groups
});

test('applySpintax handles no-spin templates and empties safely', () => {
  assert.equal(applySpintax('plain text', 's'), 'plain text');
  assert.equal(applySpintax('', 's'), '');
  assert.equal(applySpintax(null, 's'), '');
});

test('hasSpintax detects spin groups only', () => {
  assert.ok(hasSpintax('{a|b} c'));
  assert.ok(!hasSpintax('no spins here'));
  assert.ok(!hasSpintax('{{merge|fallback}}')); // double-brace is a merge token
});

test('hashStr is stable and unsigned', () => {
  assert.equal(hashStr('abc'), hashStr('abc'));
  assert.notEqual(hashStr('abc'), hashStr('abd'));
  assert.ok(hashStr('anything') >= 0);
});

// ── Content spam-linter ──────────────────────────────────────────────────────
const { lintContent, lintSteps } = require('../outreachContent');

test('lintContent passes clean, natural cold-email copy (no false positives)', () => {
  const r = lintContent({
    subject: 'custom merch for Green Leaf',
    body: 'Hey Sam,\n\nI run Joint Printing — we make custom apparel for dispensaries. I\'ll design free mockups with your branding so you can see real product first.\n\nReply with what you\'re thinking and a rough quantity.\n\n— Nate',
  });
  assert.equal(r.level, 'ok');
  assert.ok(r.score >= 80, `expected clean copy to score high, got ${r.score}`);
  assert.equal(r.issues.length, 0);
});

test('lintContent flags spam phrasing, ALL-CAPS subject, and !!!', () => {
  const r = lintContent({ subject: 'ACT NOW LIMITED TIME', body: 'CLICK HERE to BUY NOW!!! 100% free money!!!' });
  assert.ok(r.score < 80);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes('spam-words'));
  assert.ok(codes.includes('subject-caps'));
});

test('lintContent flags link stuffing and a bare-link body', () => {
  const many = lintContent({ subject: 'hi', body: 'https://a.com https://b.com https://c.com https://d.com' });
  assert.ok(many.issues.some((i) => i.code === 'links'));
  const bare = lintContent({ subject: 'hi', body: 'see this https://a.com' });
  assert.ok(bare.issues.some((i) => i.code === 'bare-link'));
});

test('lintContent flags a too-long subject and an empty body', () => {
  const longSubj = lintContent({ subject: 'x'.repeat(80), body: 'plenty of real text here to avoid the bare-link and empty flags entirely.' });
  assert.ok(longSubj.issues.some((i) => i.code === 'subject-long'));
  const empty = lintContent({ subject: 'hi', body: '' });
  assert.ok(empty.issues.some((i) => i.code === 'empty-body'));
});

test('lintSteps lints each step and tags its index', () => {
  const out = lintSteps([{ subject: 'ok subject', body: 'a nice bit of real body text goes right here for the reviewer.' }, { subject: 'BUY NOW!!!', body: 'CLICK HERE' }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].step, 0);
  assert.equal(out[1].step, 1);
  assert.ok(out[1].score < out[0].score);
});
