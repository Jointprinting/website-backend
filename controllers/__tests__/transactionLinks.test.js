// controllers/__tests__/transactionLinks.test.js
//
// Pure-logic checks for the two ecosystem links added to Transaction — the
// order#→projectNumber bridge behind /api/finances/by-project, and the CRM
// contact sanitizer behind the ★ main-contact PATCH. Runs on Node's built-in
// test runner — no extra dev deps:
//
//   node --test controllers/__tests__/transactionLinks.test.js
//
// Both helpers take plain POJOs, so they're testable without Mongo. The point
// is to PIN the collision-safety rules (never guess on ambiguity) and the
// single-primary invariant so they can't silently drift.

const test = require('node:test');
const assert = require('node:assert/strict');

const { projectNumberByOrderNumber } = require('../finances');
const { sanitizeContacts } = require('../crm');
const Transaction = require('../../models/Transaction');

test('projectNumberByOrderNumber: maps canonical order # → project #', () => {
  const map = projectNumberByOrderNumber([
    { orderNumber: '0000021', projectNumber: '138' },
    { orderNumber: '35', projectNumber: 141 },
  ]);
  assert.equal(map['21'], '138');   // leading zeros stripped on the key
  assert.equal(map['35'], '141');   // numeric project # normalized to string
});

test('projectNumberByOrderNumber: first real project # wins; blanks never overwrite', () => {
  const map = projectNumberByOrderNumber([
    { orderNumber: '21', projectNumber: '' },      // blank contributes nothing
    { orderNumber: '021', projectNumber: '138' },
    { orderNumber: '21', projectNumber: '' },      // later blank can't clear it
  ]);
  assert.equal(map['21'], '138');
});

test('projectNumberByOrderNumber: a genuine collision is ambiguous → empty, not a guess', () => {
  const map = projectNumberByOrderNumber([
    { orderNumber: '21', projectNumber: '138' },
    { orderNumber: '0021', projectNumber: '999' }, // same canonical #, different project
  ]);
  assert.equal(map['21'], '');
});

test('projectNumberByOrderNumber: garbage in, clean map out', () => {
  const map = projectNumberByOrderNumber([null, {}, { orderNumber: '', projectNumber: '5' }]);
  assert.deepEqual(map, {});
  assert.deepEqual(projectNumberByOrderNumber(undefined), {});
});

test('sanitizeContacts: trims fields, drops all-blank rows, keeps known fields only', () => {
  const out = sanitizeContacts([
    { name: '  Dana  ', role: ' buyer ', phone: ' 856-555-1234 ', email: ' d@x.com ', junk: 'no' },
    { name: '', role: '', phone: '', email: '' },   // dropped
    null,                                            // dropped
  ]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { name: 'Dana', role: 'buyer', phone: '856-555-1234', email: 'd@x.com', isPrimary: false });
});

test('sanitizeContacts: at most ONE ★ primary — first starred wins', () => {
  const out = sanitizeContacts([
    { name: 'A', isPrimary: false },
    { name: 'B', isPrimary: true },
    { name: 'C', isPrimary: true },   // demoted — B already took the star
  ]);
  assert.deepEqual(out.map((c) => c.isPrimary), [false, true, false]);
});

test('sanitizeContacts: a starred BLANK row cannot steal the star from a real contact', () => {
  // Regression: star assigned before blank-filtering let an empty just-added row
  // consume the one primary and then get dropped — persisting NO primary and
  // silently un-starring the real main contact.
  const out = sanitizeContacts([
    { name: 'A', isPrimary: false },
    { name: '', role: '', phone: '', email: '', isPrimary: true }, // blank + starred → dropped
    { name: 'B', isPrimary: true },
  ]);
  assert.deepEqual(out.map((c) => [c.name, c.isPrimary]), [['A', false], ['B', true]]);
});

test('sanitizeContacts: non-array input → empty list', () => {
  assert.deepEqual(sanitizeContacts(undefined), []);
  assert.deepEqual(sanitizeContacts('nope'), []);
});

test('finance config vocabulary comes straight from the Transaction model', () => {
  // The /api/finances/config endpoint serves these statics verbatim — pin that
  // the model actually carries them so the endpoint can never serve undefined.
  assert.ok(Array.isArray(Transaction.CATEGORIES) && Transaction.CATEGORIES.includes('Customer Sales'));
  assert.ok(Array.isArray(Transaction.COGS_CATEGORIES) && Transaction.COGS_CATEGORIES.includes('Printer COGS'));
  assert.equal(typeof Transaction.PROCESSING_FEE_RATES.cc, 'number');
  assert.equal(typeof Transaction.PROCESSING_FEE_RATES.ach, 'number');
});
