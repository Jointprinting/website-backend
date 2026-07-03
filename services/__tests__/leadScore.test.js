// services/__tests__/leadScore.test.js
//
// Unit tests for lead quality scoring (services/leadScore.js): the reach signals
// (email / phone / address / contact / deal value), the do-not-email penalty, and
// the score → grade thresholds.

const test = require('node:test');
const assert = require('node:assert');

const { scoreLead, gradeFor } = require('../leadScore');

test('a fully-reachable lead grades A', () => {
  const r = scoreLead({
    email: 'buyer@dispo.com',
    phone: '(856) 555-1212',
    address: '123 Main St, Newark NJ 07102',
    contacts: [{ name: 'Sam Buyer', email: 'sam@dispo.com' }],
    dealValue: 1500,
  });
  assert.strictEqual(r.score, 100);
  assert.strictEqual(r.grade, 'A');
  assert.deepStrictEqual(r.reasons.sort(), ['address', 'callable', 'contact', 'deal-value', 'emailable']);
});

test('emailable alone is a C (40)', () => {
  const r = scoreLead({ email: 'x@y.com' });
  assert.strictEqual(r.score, 40);
  assert.strictEqual(r.grade, 'C');
  assert.deepStrictEqual(r.reasons, ['emailable']);
});

test('do-not-email suppresses the email points and is flagged', () => {
  const r = scoreLead({ email: 'x@y.com', doNotEmail: true, address: '9 Elm St' });
  assert.strictEqual(r.score, 25); // address only; email not counted
  assert.ok(r.reasons.includes('do-not-email'));
  assert.ok(!r.reasons.includes('emailable'));
});

test('road-visitable (address) + callable without email is a B', () => {
  const r = scoreLead({ address: '10 State St, Camden NJ', phone: '609-555-9000' });
  assert.strictEqual(r.score, 40); // 25 + 15
  assert.strictEqual(r.grade, 'C');
});

test('contact-level email and phone count when top-level is blank', () => {
  const r = scoreLead({ contacts: [{ name: 'Pat', email: 'pat@shop.com', phone: '2015551234' }] });
  assert.ok(r.reasons.includes('emailable'));
  assert.ok(r.reasons.includes('callable'));
  assert.ok(r.reasons.includes('contact'));
  assert.strictEqual(r.score, 40 + 15 + 10);
});

test('an unreachable bare name grades D', () => {
  const r = scoreLead({ companyName: 'Mystery Dispensary' });
  assert.strictEqual(r.score, 0);
  assert.strictEqual(r.grade, 'D');
  assert.deepStrictEqual(r.reasons, []);
});

test('a vague legacy region (no street number) is not a road-visit address', () => {
  const r = scoreLead({ area: 'North Jersey', address: 'North Jersey' });
  assert.ok(!r.reasons.includes('address'));
});

test('gradeFor thresholds', () => {
  assert.strictEqual(gradeFor(75), 'A');
  assert.strictEqual(gradeFor(74), 'B');
  assert.strictEqual(gradeFor(50), 'B');
  assert.strictEqual(gradeFor(49), 'C');
  assert.strictEqual(gradeFor(25), 'C');
  assert.strictEqual(gradeFor(24), 'D');
});
