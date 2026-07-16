// controllers/__tests__/crmDesignLibrary.test.js
//
// Pure-logic checks for the company Design Library gather (no DB). Runs on Node's
// built-in test runner:
//
//   node --test controllers/__tests__/crmDesignLibrary.test.js
//
// designLibraryQuery + assembleDesignLibrary are exported from controllers/crm.js
// and take plain POJOs (orders / library docs / logo doc), so they're testable
// without Mongo.

const test = require('node:test');
const assert = require('node:assert/strict');

const { designLibraryQuery, assembleDesignLibrary } = require('../crm');

test('designLibraryQuery: distinct referenced numbers + distinct name candidates', () => {
  const orders = [
    { mockupNumbers: ['#000150A', '#000150B'] },
    { mockupNumbers: ['#000150A'] },            // dup number across orders
    { mockupNumbers: [] },
    {},                                          // no field
  ];
  const client = { companyName: 'Acme Co', clientName: 'Acme Co', akas: ['Acme', ''] };
  const { rawNums, nameSet } = designLibraryQuery(orders, client);
  assert.deepEqual(rawNums.sort(), ['#000150A', '#000150B']);       // de-duped
  assert.deepEqual(nameSet.sort(), ['Acme', 'Acme Co']);            // de-duped, blanks dropped
});

test('designLibraryQuery: tolerates missing client / empty orders', () => {
  assert.deepEqual(designLibraryQuery([], null), { rawNums: [], nameSet: [] });
  assert.deepEqual(designLibraryQuery(null, {}), { rawNums: [], nameSet: [] });
});

test('assembleDesignLibrary: links each mockup to the first order referencing its number', () => {
  const orders = [
    { orderNumber: '1001', projectNumber: '150', mockupNumbers: ['#000150A'] },
    { orderNumber: '1002', projectNumber: '151', mockupNumbers: ['#000151A'] },
  ];
  const mockDocs = [
    { _id: 'm1', name: 'Front tee', pageState: { mockupNum: '#000150A' }, thumbnail: 'https://r2/a.png', savedAt: 3 },
    { _id: 'm2', name: 'Hoodie',    pageState: { mockupNum: '#000151A' }, thumbnail: '',                 savedAt: 2 },
  ];
  const { mockups, logos } = assembleDesignLibrary({ orders, mockDocs, logoDoc: null });
  assert.equal(logos.length, 0);
  assert.equal(mockups.length, 2);
  assert.deepEqual(
    mockups.find((m) => m._id === 'm1'),
    { _id: 'm1', name: 'Front tee', mockupNum: '#000150A', thumbnail: 'https://r2/a.png', savedAt: 3, orderNumber: '1001', projectNumber: '150' },
  );
  // m2 links to order 1002 by its number even with an empty thumbnail.
  const m2 = mockups.find((m) => m._id === 'm2');
  assert.equal(m2.orderNumber, '1002');
  assert.equal(m2.projectNumber, '151');
  assert.equal(m2.thumbnail, '');
});

test('assembleDesignLibrary: normalized match bridges #/zero-pad/case drift', () => {
  const orders = [{ orderNumber: '1001', projectNumber: '150', mockupNumbers: ['#000150A'] }];
  // mockup stored as lowercase, no hash, no zero-pad — must still link.
  const mockDocs = [{ _id: 'm1', pageState: { mockupNum: '150a' }, thumbnail: 'x' }];
  const { mockups } = assembleDesignLibrary({ orders, mockDocs, logoDoc: null });
  assert.equal(mockups[0].orderNumber, '1001');
});

test('assembleDesignLibrary: unmatched mockup shows unlinked (no order fields)', () => {
  const orders = [{ orderNumber: '1001', projectNumber: '150', mockupNumbers: ['#000150A'] }];
  const mockDocs = [{ _id: 'm9', name: 'WIP', pageState: { mockupNum: '#000999Z' }, thumbnail: 'x' }];
  const { mockups } = assembleDesignLibrary({ orders, mockDocs, logoDoc: null });
  assert.equal(mockups[0].orderNumber, '');
  assert.equal(mockups[0].projectNumber, '');
});

test('assembleDesignLibrary: de-dupes the same mockup doc by _id', () => {
  const orders = [];
  const mockDocs = [
    { _id: 'm1', pageState: { mockupNum: '#000150A' }, thumbnail: 'x' },
    { _id: 'm1', pageState: { mockupNum: '#000150A' }, thumbnail: 'x' },  // same id twice (name + number both matched)
  ];
  const { mockups } = assembleDesignLibrary({ orders, mockDocs, logoDoc: null });
  assert.equal(mockups.length, 1);
});

test('assembleDesignLibrary: surfaces the logo when present', () => {
  const logoDoc = { _id: 'lg1', imageDataUrl: 'data:image/png;base64,AAA', uploadedAt: '2026-01-01' };
  const { logos } = assembleDesignLibrary({ orders: [], mockDocs: [], logoDoc });
  assert.deepEqual(logos, [{ _id: 'lg1', imageDataUrl: 'data:image/png;base64,AAA', uploadedAt: '2026-01-01' }]);
});
