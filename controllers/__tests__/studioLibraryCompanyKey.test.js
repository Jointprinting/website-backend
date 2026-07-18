const test = require('node:test');
const assert = require('node:assert');
const { resolveCompanyKeyFor } = require('../studioLibrary');
const { deriveCompanyKey, normMockupNum } = require('../../utils/companyKey');

test('deriveCompanyKey matches the Order rule (lowercase, strip non-alnum)', () => {
  assert.strictEqual(deriveCompanyKey('Acme Printing!'), 'acmeprinting');
  assert.strictEqual(deriveCompanyKey('', 'Bob & Co'), 'bobco');
  assert.strictEqual(deriveCompanyKey(''), '');
});

test('normMockupNum drops hash + leading zeros but keeps the colour letter', () => {
  assert.strictEqual(normMockupNum('#000150A'), '150A');
  assert.strictEqual(normMockupNum('0000021B'), '21B');
  assert.strictEqual(normMockupNum(''), '');
});

test('resolveCompanyKeyFor: prefers the order companyKey by mockup number', () => {
  const orderMap = new Map([['150A', 'acmeprinting']]);
  const m = { client: 'Some Other Name', pageState: { mockupNum: '#000150A' } };
  assert.strictEqual(resolveCompanyKeyFor(m, orderMap), 'acmeprinting');
});

test('resolveCompanyKeyFor: falls back to the client name when no order matches', () => {
  const m = { client: 'Acme Printing!', pageState: { mockupNum: '#000999Z' } };
  assert.strictEqual(resolveCompanyKeyFor(m, new Map()), 'acmeprinting');
});

test('resolveCompanyKeyFor: empty when there is nothing to derive from', () => {
  assert.strictEqual(resolveCompanyKeyFor({ client: '', pageState: {} }, new Map()), '');
  assert.strictEqual(resolveCompanyKeyFor({}, new Map()), '');
});
