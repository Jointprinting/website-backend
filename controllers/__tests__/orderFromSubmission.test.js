// controllers/__tests__/orderFromSubmission.test.js
//   node --test controllers/__tests__/orderFromSubmission.test.js
// The pure builder behind POST /orders/from-submission/:id ("Start project from
// inquiry") — carries the brand source + summarizes the inquiry into notes.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOrderFromSubmission } = require('../orders');

test('carries the brand source through and stamps the inquiry linkage', () => {
  const sub = { _id: 'sub1', companyName: 'Green Room', name: 'Dana', source: 'webworks' };
  const o = buildOrderFromSubmission(sub, '#000210');
  assert.equal(o.projectNumber, '#000210');
  assert.equal(o.companyName, 'Green Room');
  assert.equal(o.clientName, 'Dana');
  assert.equal(o.status, 'quoted');
  assert.equal(o.contactSubmissionId, 'sub1');
  assert.equal(o.inquirySource, 'webworks');
  assert.equal(o.importedFrom, 'inquiry');
});

test('atom + contact sources pass through; legacy/unknown → contact', () => {
  assert.equal(buildOrderFromSubmission({ source: 'atom' }, '#1').inquirySource, 'atom');
  assert.equal(buildOrderFromSubmission({ source: 'contact' }, '#1').inquirySource, 'contact');
  assert.equal(buildOrderFromSubmission({}, '#1').inquirySource, 'contact');          // no source
  assert.equal(buildOrderFromSubmission({ source: 'nonsense' }, '#1').inquirySource, 'contact');
});

test('summarizes the inquiry fields into notes, skipping blanks', () => {
  const o = buildOrderFromSubmission(
    { notes: '50 hoodies', quantity: '50', inHandDate: 'Aug 1', shipToState: 'NJ', source: 'contact' },
    '#2',
  );
  assert.equal(o.notes, 'Inquiry notes: 50 hoodies\nQuantity: 50\nIn-hand by: Aug 1\nShip to: NJ');

  const sparse = buildOrderFromSubmission({ quantity: '12' }, '#3');
  assert.equal(sparse.notes, 'Quantity: 12'); // only the present field, no empty lines
});

test('tolerates a null submission', () => {
  const o = buildOrderFromSubmission(null, '#4');
  assert.equal(o.companyName, '');
  assert.equal(o.inquirySource, 'contact');
  assert.equal(o.importedFrom, 'inquiry');
});
