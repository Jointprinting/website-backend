// services/__tests__/dataCleanup.test.js
//
// Pins the pure detections behind the owner-run "Fix data" cleanup tool. No DB:
//
//   node --test services/__tests__/dataCleanup.test.js
//
// They must surface ONLY genuine problems (so the owner is never asked to re-enter
// history) and stay conservative — especially the contact-split, which must not
// mangle a legit company name that merely contains a comma.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveCompanyKey, normalizeOrderNumber, splitPollutedName,
  detectOrphanOrders, detectPollutedClients, detectMisKeyedReceipts,
} = require('../dataCleanup');

// ── orphaned orders ──────────────────────────────────────────────────────────
test('detectOrphanOrders: flags named orders with no companyKey, derives the key', () => {
  const r = detectOrphanOrders([
    { _id: 'a', orderNumber: '141', companyName: 'Happy Leaf Dispensary', clientName: '', companyKey: '' },
    { _id: 'b', orderNumber: '140', companyName: 'Coastline', clientName: '', companyKey: 'coastline' }, // already keyed
    { _id: 'c', orderNumber: '99', companyName: '', clientName: '', companyKey: '' },                     // no name → skip
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].orderId, 'a');
  assert.equal(r[0].derivedKey, 'happyleafdispensary');
});

// ── contact-split (the conservative gate) ────────────────────────────────────
test('splitPollutedName: splits only when the left segment IS the stored contact', () => {
  // The real Happy Leaf case.
  assert.deepEqual(
    splitPollutedName('Nathan Vigil, Happy Leaf Dispensary', 'Nathan Vigil'),
    { contact: 'Nathan Vigil', company: 'Happy Leaf Dispensary' },
  );
  // Legit company name with a comma but the left is NOT the contact → never split.
  assert.equal(splitPollutedName('Smith, Jones & Co', 'Dana Park'), null);
  // No comma → nothing to split.
  assert.equal(splitPollutedName('Happy Leaf Dispensary', 'Nathan Vigil'), null);
  // Empty contact → can't confirm pollution → skip.
  assert.equal(splitPollutedName('Nathan Vigil, Happy Leaf', ''), null);
});

test('detectPollutedClients: flags polluted, skips clean + archived', () => {
  const r = detectPollutedClients([
    { _id: 'x', companyKey: 'nathanvigilhappyleafdispensary', companyName: 'Nathan Vigil, Happy Leaf Dispensary', clientName: 'Nathan Vigil' },
    { _id: 'y', companyKey: 'coastline', companyName: 'Coastline', clientName: 'Sam' },                 // clean
    { _id: 'z', companyName: 'Bob, Acme', clientName: 'Bob', archived: true },                          // archived → skip
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].clientId, 'x');
  assert.equal(r[0].cleanCompany, 'Happy Leaf Dispensary');
  assert.equal(r[0].contact, 'Nathan Vigil');
});

// ── mis-keyed receipts ───────────────────────────────────────────────────────
test('detectMisKeyedReceipts: flags expense COGS whose order # matches no order', () => {
  const orderKeys = new Set(['1050', '141']);
  const r = detectMisKeyedReceipts([
    { _id: 't1', type: 'expense', category: 'Blank COGS', orderNumber: '#73938537', party: 'S&S Activewear', amount: 482.46 }, // orphan
    { _id: 't2', type: 'expense', category: 'Printer COGS', orderNumber: '1050', amount: 200 },         // links → ok
    { _id: 't3', type: 'income', category: 'Customer Sales', orderNumber: '999', amount: 50 },          // income → ignore
    { _id: 't4', type: 'expense', category: 'Software', orderNumber: '888', amount: 9 },                 // non-COGS → ignore
  ], orderKeys);
  assert.equal(r.length, 1);
  assert.equal(r[0].txnId, 't1');
  assert.equal(r[0].amount, 482.46);
  assert.equal(r[0].party, 'S&S Activewear');
});

test('detectMisKeyedReceipts: leading-zero variants still match a real order', () => {
  const r = detectMisKeyedReceipts(
    [{ _id: 't', type: 'expense', category: 'Blank COGS', orderNumber: '0001050', amount: 10 }],
    new Set(['1050']),
  );
  assert.equal(r.length, 0);
});

// ── helpers ──────────────────────────────────────────────────────────────────
test('helpers: deriveCompanyKey + normalizeOrderNumber match the rest of the system', () => {
  assert.equal(deriveCompanyKey('Happy Leaf Dispensary', ''), 'happyleafdispensary');
  assert.equal(deriveCompanyKey('', 'Nathan Vigil'), 'nathanvigil');
  assert.equal(normalizeOrderNumber('#0001050'), '1050');
  assert.equal(normalizeOrderNumber('1050'), '1050');
  assert.equal(normalizeOrderNumber('abc'), '');
});
