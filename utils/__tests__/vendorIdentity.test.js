// Vendor identity — the last of the "match on free text" bugs.
//
// A vendor was found by a case-insensitive regex built from the raw typed name,
// and the ~5 sites that did it DISAGREED about whitespace: some collapsed runs
// of spaces, some didn't. So "Heritage  Printing" could fail to find "Heritage
// Printing" and quietly mint a SECOND vendor record — with its own PO numbering
// sequence, which is how one printer ends up with two #005s.
//
// vendorKey is now stored and indexed on both Vendor and PurchaseOrder, derived
// by model hooks on every write path. These pin the derivation and the hooks;
// the lookups themselves are integration-level.

const test = require('node:test');
const assert = require('node:assert');

const { vendorKey } = require('../poCost');
const { withVendorKey } = require('../vendorKeySync');
const Vendor = require('../../models/Vendor');
const PurchaseOrder = require('../../models/PurchaseOrder');

test('the key collapses exactly what a human typo varies', () => {
  const canonical = 'heritage screen printing';
  for (const typed of [
    'Heritage Screen Printing',
    'heritage screen printing',
    'HERITAGE SCREEN PRINTING',
    '  Heritage Screen Printing  ',
    'Heritage  Screen   Printing',      // the fork that started this
    '\tHeritage Screen Printing\n',
  ]) {
    assert.strictEqual(vendorKey(typed), canonical, `${JSON.stringify(typed)} should key canonically`);
  }
});

test('genuinely different printers keep different keys', () => {
  assert.notStrictEqual(vendorKey('Heritage Screen Printing'), vendorKey('Heritage Sportswear'));
  assert.notStrictEqual(vendorKey('S&S Activewear'), vendorKey('SS Activewear'));
});

test('empty and missing names key to empty, never to a shared bucket', () => {
  // Critical: if blanks keyed to the same non-empty value, every unnamed record
  // would resolve to one another.
  assert.strictEqual(vendorKey(''), '');
  assert.strictEqual(vendorKey('   '), '');
  assert.strictEqual(vendorKey(null), '');
  assert.strictEqual(vendorKey(undefined), '');
});

test('a Vendor derives its key on save', async () => {
  const v = new Vendor({ name: 'Heritage  Screen Printing ' });
  await v.validate();
  assert.strictEqual(v.vendorKey, 'heritage screen printing');
});

test('a PurchaseOrder derives its key on save', async () => {
  const po = new PurchaseOrder({ vendorName: '  S&S   Activewear', poNumber: '7' });
  await po.validate();
  assert.strictEqual(po.vendorKey, 's&s activewear');
});

test('renaming a vendor re-derives the key — it cannot go stale', async () => {
  const v = new Vendor({ name: 'Heritage' });
  await v.validate();
  assert.strictEqual(v.vendorKey, 'heritage');
  v.name = 'Heritage Screen Printing';
  await v.validate();
  assert.strictEqual(v.vendorKey, 'heritage screen printing');
});

// ── The update paths (withVendorKey is the shared hook body) ────────────────

test('a $set update carries the key alongside the name', () => {
  const out = withVendorKey({ $set: { name: 'Heritage  Printing' } }, 'name');
  assert.strictEqual(out.$set.vendorKey, 'heritage printing');
  assert.strictEqual(out.$set.name, 'Heritage  Printing', 'the name itself is untouched');
});

test('an upsert seeding the name via $setOnInsert is keyed too', () => {
  // THE PATH THAT MATTERS: the contact book learns a vendor via findOneAndUpdate
  // upsert. Missing it would leave those rows unkeyed and invisible to key
  // lookups — worse than no key, because the name fallback would silently carry
  // them and the bug would hide instead of failing loudly.
  const out = withVendorKey({ $setOnInsert: { name: 'Brand  New   Printer' } }, 'name');
  assert.strictEqual(out.$set.vendorKey, 'brand new printer');
  assert.deepStrictEqual(out.$setOnInsert, { name: 'Brand  New   Printer' });
});

test('a bare (operator-free) update is keyed inline, not in $set', () => {
  // Mixing operator and plain-path forms in one update is a mongo error.
  const out = withVendorKey({ name: 'S&S Activewear' }, 'name');
  assert.strictEqual(out.vendorKey, 's&s activewear');
  assert.ok(!out.$set, 'must not introduce operators into a plain update');
});

test('an update that does NOT touch the name is left completely alone', () => {
  const original = { $set: { phone: '555-0100' } };
  const out = withVendorKey(original, 'name');
  assert.deepStrictEqual(out, original);
  assert.ok(!('vendorKey' in (out.$set || {})), 'no key written when no name was set');
});

test('withVendorKey never mutates the caller\'s update object', () => {
  const original = { $set: { name: 'Heritage' } };
  withVendorKey(original, 'name');
  assert.strictEqual(original.$set.vendorKey, undefined);
});

test('it reads the PO name field too, not just "name"', () => {
  const out = withVendorKey({ $set: { vendorName: 'Heritage  Printing' } }, 'vendorName');
  assert.strictEqual(out.$set.vendorKey, 'heritage printing');
});

test('$set wins over $setOnInsert when an upsert sets both', () => {
  const out = withVendorKey(
    { $set: { name: 'New Name' }, $setOnInsert: { name: 'Seed Name' } }, 'name');
  assert.strictEqual(out.$set.vendorKey, 'new name');
});

test('handles a null/empty update without throwing', () => {
  assert.deepStrictEqual(withVendorKey(null, 'name'), {});
  assert.deepStrictEqual(withVendorKey({}, 'name'), {});
});
