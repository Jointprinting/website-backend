// services/__tests__/suppression.test.js
//
// The pure normalization helpers behind the global suppression list. The DB
// writes/reads (suppress/isSuppressed/suppressedSet) need Mongo, so — like the
// rest of the suite — only the pure bits are unit-tested here.
//
//   node --test services/__tests__/suppression.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { normEmail, domainOf, isEmail } = require('../suppression');

test('normEmail lowercases + trims, tolerates junk', () => {
  assert.equal(normEmail('  Buyer@GreenLeaf.COM '), 'buyer@greenleaf.com');
  assert.equal(normEmail(null), '');
  assert.equal(normEmail(undefined), '');
});

test('domainOf extracts the domain, blank when there is no @', () => {
  assert.equal(domainOf('owner@highlanddispo.com'), 'highlanddispo.com');
  assert.equal(domainOf('BUYER@Green.Co'), 'green.co');
  assert.equal(domainOf('notanemail'), '');
});

test('isEmail accepts real addresses, rejects garbage', () => {
  assert.ok(isEmail('a@b.com'));
  assert.ok(isEmail('first.last@sub.domain.io'));
  assert.ok(!isEmail('a@b'));
  assert.ok(!isEmail('nope'));
  assert.ok(!isEmail(''));
});
