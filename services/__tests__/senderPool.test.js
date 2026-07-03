// services/__tests__/senderPool.test.js
//
// The pure identity-list parser behind the multi-inbox sending pool. Reading env
// + caching is exercised live; here we pin the parse + legacy fallback + label
// dedup logic.
//
//   node --test services/__tests__/senderPool.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseSenders, normalizeSender } = require('../senderPool');

test('parseSenders reads a JSON array of identities', () => {
  const json = JSON.stringify([
    { label: 'brevo', from: 'nate@getjp.com', replyTo: 'nate@jointprinting.com', host: 'smtp-relay.brevo.com', port: 587, user: 'u1', pass: 'p1', dailyCap: 250 },
    { label: 'mailjet', from: 'hi@getjp.com', host: 'in-v3.mailjet.com', user: 'u2', pass: 'p2', dailyCap: 200 },
  ]);
  const s = parseSenders(json, {});
  assert.equal(s.length, 2);
  assert.equal(s[0].label, 'brevo');
  assert.equal(s[0].dailyCap, 250);
  assert.deepEqual(s[0].smtp, { host: 'smtp-relay.brevo.com', port: 587, user: 'u1', pass: 'p1' });
  assert.equal(s[1].label, 'mailjet');
});

test('parseSenders falls back to the legacy single identity when unset/blank', () => {
  const legacy = { from: 'nate@jp.com', replyTo: 'r@jp.com', host: 'smtp.sp.com', port: '587', user: 'u', pass: 'p', dailyCap: '50' };
  const s = parseSenders('', legacy);
  assert.equal(s.length, 1);
  assert.equal(s[0].label, 'primary');
  assert.equal(s[0].from, 'nate@jp.com');
  assert.equal(s[0].dailyCap, 50);
  // Malformed JSON also falls back.
  assert.equal(parseSenders('{not json', legacy).length, 1);
});

test('parseSenders returns [] when there is no identity at all', () => {
  assert.deepEqual(parseSenders('', {}), []);
  assert.deepEqual(parseSenders('[]', {}), []);
});

test('parseSenders dedups colliding labels and drops entries with no from', () => {
  const json = JSON.stringify([
    { label: 'x', from: 'a@jp.com' },
    { label: 'x', from: 'b@jp.com' },
    { label: 'y' }, // no from → dropped
  ]);
  const s = parseSenders(json, {});
  assert.equal(s.length, 2);
  assert.equal(s[0].label, 'x');
  assert.equal(s[1].label, 'x-2'); // deduped
});

test('normalizeSender: no own SMTP → smtp is null (uses the global transport)', () => {
  const n = normalizeSender({ label: 'g', from: 'a@jp.com', dailyCap: 40 }, 0);
  assert.equal(n.smtp, null);
  assert.equal(n.dailyCap, 40);
  assert.equal(normalizeSender({}, 0), null); // no from
});
