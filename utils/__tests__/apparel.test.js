// Who supplies the blanks — the owner's actual rule.
//
// "I only have printers supply blanks when it's promo products like lighters or
// stress balls, cause they manufacture and print those themselves. Apparel I
// order from S&S or approved vendors (supply blanks myself) to ship to the
// printer."
//
// So blanksProvided follows the PRODUCT, not the vendor. The PO seeders used to
// read only the vendor's remembered boolean, which got the common case right by
// luck and a mixed order wrong on principle.

const test = require('node:test');
const assert = require('node:assert');

const { isApparelDescription, isApparelItem, blanksModeForItems } = require('../apparel');

test('recognises the apparel he actually sells', () => {
  for (const s of ['Gildan 5000 T-Shirt', 'heavyweight hoodie', 'Crewneck', 'dad hats',
    'long sleeve tee', 'zip-up', 'fleece joggers', 'Beanies', 'polo']) {
    assert.ok(isApparelDescription(s), `${s} should read as apparel`);
  }
});

test('does not mistake promo for apparel', () => {
  for (const s of ['Custom Lighters', 'stress balls', 'grinder', 'rolling trays',
    'mylar bags', 'stickers', 'keychain', 'Glass Ashtrays']) {
    assert.ok(!isApparelDescription(s), `${s} should NOT read as apparel`);
  }
});

test('an owner-flagged clothing-exempt item is apparel, full stop', () => {
  // taxExempt === true means he confirmed it's NJ clothing-exempt.
  assert.strictEqual(isApparelItem({ description: 'mystery item', taxExempt: true }), true);
});

test('taxExempt FALSE is not trusted as promo — the field defaults to false', () => {
  // THE TRAP. An apparel item that was never flagged would otherwise claim the
  // printer supplied the garments, and the blanks receipt would go unchased.
  assert.strictEqual(isApparelItem({ description: 'Gildan 5000 T-Shirt', taxExempt: false }), true);
});

test('a genuine promo item with taxExempt false stays promo', () => {
  assert.strictEqual(isApparelItem({ description: 'Custom Lighters', taxExempt: false }), false);
});

test('falls back to the style code when the description is bare', () => {
  assert.strictEqual(isApparelItem({ description: '', styleCode: 'hoodie 18500' }), true);
});

// ── The PO-level answer ─────────────────────────────────────────────────────

test('an apparel group: JP supplies the blanks', () => {
  assert.strictEqual(blanksModeForItems([{ description: 'T-Shirt' }, { description: 'Hoodie' }]), true);
});

test('a promo group: the printer manufactures and prints them', () => {
  assert.strictEqual(blanksModeForItems([{ description: 'Lighters' }, { description: 'stress balls' }]), false);
});

test('a MIXED group is true — the apparel blanks in it were really bought', () => {
  // He bought the shirts from S&S; that Blank COGS receipt exists and should be
  // chased even though the lighters on the same PO came from the printer.
  assert.strictEqual(blanksModeForItems([{ description: 'Lighters' }, { description: 'T-Shirt' }]), true);
});

test('nothing to judge returns null, so the caller can use the vendor default', () => {
  assert.strictEqual(blanksModeForItems([]), null);
  assert.strictEqual(blanksModeForItems(null), null);
  assert.strictEqual(blanksModeForItems([null, undefined]), null);
});

test('the real shape: a promo-only PO stops expecting a blanks receipt', () => {
  const promoPo = [
    { description: 'Custom Lighters, 500 units', taxExempt: false },
    { description: 'Glass Ashtrays, 100 units', taxExempt: false },
  ];
  assert.strictEqual(blanksModeForItems(promoPo), false);
});

test('the real shape: an S&S apparel run expects one', () => {
  const apparelPo = [
    { description: 'Gildan 5000 Tee', styleCode: '5000', taxExempt: true },
    { description: 'Independent Hoodie', styleCode: 'SS4500', taxExempt: true },
  ];
  assert.strictEqual(blanksModeForItems(apparelPo), true);
});
