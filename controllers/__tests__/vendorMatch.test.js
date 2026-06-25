// controllers/__tests__/vendorMatch.test.js
//
// Pure-logic checks (no DB) for vendor IDENTITY + the conservative "same printer"
// dedup detection that powers /vendors/duplicates, the merge tooling, and PO
// vendor canonicalization. THE owner case the system must get right:
//   • "Heritage" and "Heritage Screen Printing" are the SAME printer → group;
//   • two genuinely-different printers ("Heritage Screen Printing" vs "Heritage
//     Sportswear") do NOT group (no false merge);
//   • the survivor folding loses nothing (learned links union, blanks fill).
//
//   node --test controllers/__tests__/vendorMatch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  vendorMatchKey, sameVendor, groupVendorDuplicates,
  pickVendorSurvivor, foldVendorFields, isTokenPrefix, tokenJaccard,
  resolveVendorFromList,
} = require('../../utils/vendorMatch');

// Mirror the controller's order-number normalizer for the fold test.
const normOrderNum = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '').replace(/^0+/, '');

// ───────────────────────────── matchKey identity ────────────────────────────

test('vendorMatchKey collapses corporate suffixes + punctuation', () => {
  assert.equal(vendorMatchKey('Heritage Inc'), 'heritage');
  assert.equal(vendorMatchKey('Heritage, Inc.'), 'heritage');
  assert.equal(vendorMatchKey('Heritage LLC'), 'heritage');
  // The whole point: the short name and the full trade name reduce to one stem.
  assert.equal(vendorMatchKey('Heritage'), 'heritage');
  assert.equal(vendorMatchKey('Heritage Screen Printing'), 'heritage');
  assert.equal(vendorMatchKey("Joe's Printing"), 'joes');
});

test('vendorMatchKey keeps genuinely different stems distinct', () => {
  // Different stems → different keys (so they do NOT collapse by key alone).
  assert.notEqual(vendorMatchKey('Heritage Screen Printing'), vendorMatchKey('Heritage Sportswear'));
  // A suffix word embedded mid-name is not stripped ("Printing Plus" keeps its
  // stem); only a TRAILING suffix is removed.
  assert.equal(vendorMatchKey('Printing Plus'), 'printingplus');
  assert.equal(vendorMatchKey('Incognito'), 'incognito');   // not "incognit"
});

// ─────────────────────────── sameVendor (the real case) ─────────────────────

test('sameVendor: Heritage variants are the same printer', () => {
  assert.equal(sameVendor('Heritage', 'Heritage Screen Printing'), true);   // prefix + matchKey
  assert.equal(sameVendor('Heritage Screen Printing', 'Heritage'), true);   // order-independent
  assert.equal(sameVendor('heritage', 'Heritage Screen Printing'), true);   // case-insensitive
  assert.equal(sameVendor('Heritage Inc', 'Heritage, Inc.'), true);         // matchKey collapse
  assert.equal(sameVendor('Heritage Screen Printing', 'Heritage Printing'), true); // strong overlap
});

test('sameVendor: distinct printers do NOT merge (conservative)', () => {
  // Same first generic word, different real stem → NOT the same.
  assert.equal(sameVendor('Heritage Screen Printing', 'Heritage Sportswear'), false);
  // Unrelated printers (share only the generic "printing" token → Jaccard 0.33).
  assert.equal(sameVendor('Heritage Screen Printing', 'Forward Printing'), false);
  assert.equal(sameVendor('Apex Apparel', 'Vertex Apparel'), false); // share only "apparel"
  assert.equal(sameVendor('Bay Graphics', 'Sun Graphics'), false);   // share only "graphics"
  // Blank / Unassigned never matches a real vendor.
  assert.equal(sameVendor('', 'Heritage'), false);
  assert.equal(sameVendor('Unassigned', 'Heritage Screen Printing'), false);
  assert.equal(sameVendor('   ', 'Heritage'), false);
});

test('isTokenPrefix + tokenJaccard primitives', () => {
  assert.equal(isTokenPrefix(['heritage'], ['heritage', 'screen', 'printing']), true);
  assert.equal(isTokenPrefix(['screen', 'heritage'], ['heritage', 'screen', 'printing']), false);
  assert.equal(isTokenPrefix(['heritage', 'screen', 'printing', 'x'], ['heritage', 'screen', 'printing']), false);
  assert.equal(tokenJaccard(['a', 'b'], ['a', 'b']), 1);
  assert.equal(tokenJaccard(['a', 'b'], ['c', 'd']), 0);
  assert.equal(Math.round(tokenJaccard(['heritage', 'sportswear'], ['heritage', 'screen', 'printing']) * 100), 25);
});

// ───────────────────────────── grouping (clusters) ──────────────────────────

test('groupVendorDuplicates clusters the Heritage identities into ONE group', () => {
  const vendors = [
    { _id: 'a', name: 'Heritage' },
    { _id: 'b', name: 'Heritage Screen Printing' },
    { _id: 'c', name: 'Forward Printing' },
    { _id: 'd', name: 'Heritage Inc' },
  ];
  const groups = groupVendorDuplicates(vendors);
  assert.equal(groups.length, 1, 'exactly one duplicate group');
  const ids = groups[0].map((v) => v._id).sort();
  assert.deepEqual(ids, ['a', 'b', 'd']);   // Forward Printing stays out
});

test('groupVendorDuplicates does NOT group two different Heritage printers', () => {
  const vendors = [
    { _id: 'a', name: 'Heritage Screen Printing' },
    { _id: 'b', name: 'Heritage Sportswear' },
  ];
  assert.deepEqual(groupVendorDuplicates(vendors), []);
});

test('groupVendorDuplicates ignores blank/Unassigned vendors', () => {
  const vendors = [
    { _id: 'a', name: 'Unassigned' },
    { _id: 'b', name: '' },
    { _id: 'c', name: 'Heritage' },
  ];
  assert.deepEqual(groupVendorDuplicates(vendors), []);
});

// ─────────────────────────── survivor + fold (no data loss) ─────────────────

test('pickVendorSurvivor prefers the record WITH details / most POs / spend', () => {
  const bare = { _id: 'bare', name: 'Heritage', contactName: '', address: '' };
  const real = { _id: 'real', name: 'Heritage Screen Printing', contactName: 'Jaide Thomas', address: '331 York Rd' };
  const stats = (v) => (v._id === 'real' ? { poCount: 6, spend: 4000, orderCount: 5 } : { poCount: 0, spend: 0, orderCount: 0 });
  assert.equal(pickVendorSurvivor([bare, real], stats)._id, 'real');
  // Order-independent.
  assert.equal(pickVendorSurvivor([real, bare], stats)._id, 'real');
});

test('foldVendorFields fills blanks, concatenates notes, unions learned links', () => {
  const survivor = {
    name: 'Heritage Screen Printing', contactName: 'Jaide Thomas', address: '',
    shipMethod: 'UPS Acct # JR2257', notes: 'real record', nextPoStart: 9,
    vendorOrders: [{ orderNumber: '21', at: new Date('2026-02-01') }],
  };
  const merged = {
    name: 'Heritage', contactName: 'IGNORED (survivor wins)', address: '331 York Rd, Warminster, PA 18974',
    shipMethod: '', notes: 'from short name', nextPoStart: 3,
    vendorOrders: [
      { orderNumber: '0000021', at: new Date('2026-05-01') }, // newer dup of 21 → wins `at`
      { orderNumber: '50', at: new Date('2026-03-01') },       // unique → kept
    ],
  };
  foldVendorFields(survivor, merged, normOrderNum);

  // Blank address filled from merged; non-blank contact/ship kept on survivor.
  assert.equal(survivor.address, '331 York Rd, Warminster, PA 18974');
  assert.equal(survivor.contactName, 'Jaide Thomas');
  assert.equal(survivor.shipMethod, 'UPS Acct # JR2257');
  // Notes concatenated (nothing lost).
  assert.match(survivor.notes, /real record/);
  assert.match(survivor.notes, /from short name/);
  // Higher next-PO floor wins.
  assert.equal(survivor.nextPoStart, 9);
  // Learned links: 21 (deduped, newest at) + 50. Two entries, canonical keys.
  const keys = survivor.vendorOrders.map((l) => l.orderNumber).sort((a, b) => Number(a) - Number(b));
  assert.deepEqual(keys, ['21', '50']);
  const link21 = survivor.vendorOrders.find((l) => l.orderNumber === '21');
  assert.equal(new Date(link21.at).toISOString(), new Date('2026-05-01').toISOString());
});

// ─────────────── PO vendor canonicalization (short name → real record) ───────

test('resolveVendorFromList: a typed short name resolves to the real record', () => {
  const book = [
    { _id: 'h', name: 'Heritage Screen Printing', contactName: 'Jaide Thomas' },
    { _id: 'f', name: 'Forward Printing' },
  ];
  // THE owner case: typing "Heritage" attaches to "Heritage Screen Printing".
  assert.equal(resolveVendorFromList('Heritage', book)._id, 'h');
  assert.equal(resolveVendorFromList('heritage', book)._id, 'h');     // case-insensitive
  assert.equal(resolveVendorFromList('Heritage Inc', book)._id, 'h'); // matchKey collapse
  // Exact existing name resolves to itself.
  assert.equal(resolveVendorFromList('Forward Printing', book)._id, 'f');
});

test('resolveVendorFromList: exact name wins over a fuzzy sibling', () => {
  const book = [
    { _id: 'short', name: 'Heritage' },
    { _id: 'full', name: 'Heritage Screen Printing' },
  ];
  // When BOTH a bare "Heritage" and the full name exist, typing the exact bare
  // name resolves to the bare record (exact tier) — not the fuzzy sibling.
  assert.equal(resolveVendorFromList('Heritage', book)._id, 'short');
  assert.equal(resolveVendorFromList('Heritage Screen Printing', book)._id, 'full');
});

test('resolveVendorFromList: ambiguous fuzzy match does NOT guess (returns null)', () => {
  // Two DIFFERENT existing printers both fuzzily match a typed stem → don't guess.
  const book = [
    { _id: 'a', name: 'Heritage Screen Printing' },
    { _id: 'b', name: 'Heritage Apparel' },
  ];
  assert.equal(resolveVendorFromList('Heritage', book), null);
});

test('resolveVendorFromList: a genuinely new vendor resolves to null (keep typed)', () => {
  const book = [{ _id: 'h', name: 'Heritage Screen Printing' }];
  assert.equal(resolveVendorFromList('Brand New Printer Co', book), null);
  // Blank / Unassigned never resolves to a real record.
  assert.equal(resolveVendorFromList('', book), null);
  assert.equal(resolveVendorFromList('Unassigned', book), null);
});
