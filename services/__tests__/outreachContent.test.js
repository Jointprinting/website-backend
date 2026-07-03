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
