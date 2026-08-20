// services/__tests__/duplicateIdentifiers.test.js
//
//   node --test services/__tests__/duplicateIdentifiers.test.js
//
// projectNumber, orderNumber, poNumber, dealNumber and remoteId are the handles
// the whole ecosystem joins on — a PO's order, a receipt's order, a finance row's
// project, a mockup's library item — and NOT ONE of them is enforced unique in
// the database. They come from atomic counters, so a duplicate means something
// bypassed the counter (a hand-typed number, an import, a restore), and when that
// happens the join silently picks one.
//
// This detection is report-only by design, so these tests are about it being
// RIGHT rather than safe to apply: the two scoping rules below are what separate
// a real collision from a false alarm, and a false alarm here would send the
// owner renumbering live jobs that were never in conflict.

const test = require('node:test');
const assert = require('node:assert/strict');

const { detectDuplicateIdentifiers } = require('../dataCleanup');

test('two orders on the same project number collide', () => {
  const r = detectDuplicateIdentifiers({
    orders: [
      { _id: 1, projectNumber: '142', companyName: 'Bleu Leaf' },
      { _id: 2, projectNumber: '142', companyName: 'Acme' },
      { _id: 3, projectNumber: '143', companyName: 'Other' },
    ],
  });
  assert.equal(r.projectNumbers.length, 1);
  assert.equal(r.projectNumbers[0].value, '142');
  assert.equal(r.projectNumbers[0].count, 2);
});

test('invoice numbers collide CANONICALLY — "0000021", "#21" and "21" are one invoice', () => {
  // That is what finance, the CRM and every reconcile pass already treat as the
  // same number, so anything else here would under-report.
  const r = detectDuplicateIdentifiers({
    orders: [
      { _id: 1, orderNumber: '0000021' },
      { _id: 2, orderNumber: '#21' },
      { _id: 3, orderNumber: '21' },
      { _id: 4, orderNumber: '22' },
    ],
  });
  assert.equal(r.orderNumbers.length, 1);
  assert.equal(r.orderNumbers[0].count, 3);
});

test('PO numbers are unique PER VENDOR, not globally', () => {
  // Each vendor has its own counter, so two vendors both holding PO 1001 is
  // correct. Reporting it would send the owner renumbering POs that were never
  // in conflict — and POs go to printers.
  const r = detectDuplicateIdentifiers({
    pos: [
      { _id: 1, vendorKey: 'heritage', poNumber: '1001' },
      { _id: 2, vendorKey: 'sanmar',   poNumber: '1001' },
      { _id: 3, vendorKey: 'sanmar',   poNumber: '1002' },
    ],
  });
  assert.equal(r.poNumbers.length, 0, 'different vendors are not a collision');

  const dup = detectDuplicateIdentifiers({
    pos: [
      { _id: 1, vendorKey: 'heritage', poNumber: '1001' },
      { _id: 2, vendorKey: 'heritage', poNumber: '1001' },
    ],
  });
  assert.equal(dup.poNumbers.length, 1);
  assert.equal(dup.poNumbers[0].count, 2);
});

test('remoteId is scoped by store — the same id in two stores is two things', () => {
  // The exact scoping the mockup delete path was missing: a remoteId colliding
  // across stores could delete a blank instead of the mockup meant.
  const across = detectDuplicateIdentifiers({
    library: [
      { _id: 1, store: 'mockups', remoteId: 'abc' },
      { _id: 2, store: 'blanks',  remoteId: 'abc' },
    ],
  });
  assert.equal(across.remoteIds.length, 0);

  const within = detectDuplicateIdentifiers({
    library: [
      { _id: 1, store: 'mockups', remoteId: 'abc' },
      { _id: 2, store: 'mockups', remoteId: 'abc' },
    ],
  });
  assert.equal(within.remoteIds.length, 1);
});

test('a blank identifier is unassigned, not duplicated', () => {
  // Most quotes have no invoice number until approval. Grouping the blanks would
  // report every un-invoiced project in the business as one giant collision.
  const r = detectDuplicateIdentifiers({
    orders: [
      { _id: 1, orderNumber: '', projectNumber: '1' },
      { _id: 2, orderNumber: '', projectNumber: '2' },
      { _id: 3, projectNumber: '3' },
    ],
  });
  assert.equal(r.orderNumbers.length, 0);
  assert.equal(r.projectNumbers.length, 0);
});

test('worst first — a three-way collision outranks a pair', () => {
  const r = detectDuplicateIdentifiers({
    orders: [
      { _id: 1, projectNumber: '10' }, { _id: 2, projectNumber: '10' },
      { _id: 3, projectNumber: '20' }, { _id: 4, projectNumber: '20' }, { _id: 5, projectNumber: '20' },
    ],
  });
  assert.deepEqual(r.projectNumbers.map((g) => g.value), ['20', '10']);
});

test('the totals count both collisions and the records caught in them', () => {
  // `records` is the number that tells the owner how much work he is looking at.
  const r = detectDuplicateIdentifiers({
    orders: [{ _id: 1, projectNumber: '10' }, { _id: 2, projectNumber: '10' }, { _id: 3, projectNumber: '10' }],
    deals: [{ _id: 4, dealNumber: 'D-1' }, { _id: 5, dealNumber: 'D-1' }],
  });
  assert.equal(r.total, 2, 'two colliding values');
  assert.equal(r.records, 5, 'five records involved');
});

test('nothing in, nothing reported', () => {
  const r = detectDuplicateIdentifiers({});
  assert.equal(r.total, 0);
  assert.equal(r.records, 0);
  assert.deepEqual(r.projectNumbers, []);
});

test('junk rows never throw', () => {
  const r = detectDuplicateIdentifiers({ orders: [null, undefined, {}], pos: [null], deals: [null], library: [null] });
  assert.equal(r.total, 0);
});
