// `blanksProvided` had OPPOSITE defaults in the two models that carry it:
// Vendor defaulted true (JP buys the blanks, the ~99% case) and PurchaseOrder
// defaulted false. The same concept, two answers.
//
// That is not cosmetic. expectedReceiptCats decides whether to nag for a missing
// Blank COGS receipt with `pos.some(p => p.blanksProvided === true)`, so ONE PO
// that took the model default instead of being set explicitly silently switched
// the nag off for its whole order — a cost receipt you'd simply never be asked
// for. createPo and createPosFromConfirmation both set it; the Drive rebuild
// loader was the one creator that didn't.

const test = require('node:test');
const assert = require('node:assert');

const Vendor = require('../../models/Vendor');
const PurchaseOrder = require('../../models/PurchaseOrder');
const { expectedReceiptCats } = require('../finances');

test('the two models agree on the default — JP supplies the blanks', () => {
  assert.strictEqual(Vendor.schema.path('blanksProvided').options.default, true);
  assert.strictEqual(PurchaseOrder.schema.path('blanksProvided').options.default, true,
    'a PO that sets nothing must not assert the rare case');
});

test('a PO created with no explicit mode expects a blanks receipt', () => {
  // The regression: this used to come out false and silence the nag.
  const po = new PurchaseOrder({ vendorName: 'Heritage', poNumber: 1 });
  assert.strictEqual(po.blanksProvided, true);
  assert.ok(expectedReceiptCats({}, [po]).includes('Blank COGS'));
});

test('an explicit false is still honored — the printer used their own blanks', () => {
  const po = new PurchaseOrder({ vendorName: 'Heritage', poNumber: 1, blanksProvided: false });
  assert.strictEqual(po.blanksProvided, false);
  assert.ok(!expectedReceiptCats({}, [po]).includes('Blank COGS'));
});

test('one JP-supplied PO is enough to expect the receipt', () => {
  const own = new PurchaseOrder({ vendorName: 'A', poNumber: 1, blanksProvided: false });
  const jp = new PurchaseOrder({ vendorName: 'B', poNumber: 2, blanksProvided: true });
  assert.ok(expectedReceiptCats({}, [own, jp]).includes('Blank COGS'));
});

test('a new vendor still defaults to JP supplying the blanks', () => {
  assert.strictEqual(new Vendor({ name: 'Brand New Printer' }).blanksProvided, true);
});

// ── The rule the owner actually runs on ─────────────────────────────────────
// "I only have printers supply blanks when it's promo products like lighters or
// stress balls, cause they manufacture and print those themselves. Apparel I
// order from S&S or approved vendors (supply blanks myself) to ship to the
// printer."
//
// So the ITEMS decide, and the vendor's remembered boolean is only the fallback.
// A vendor-only answer got the common case right by luck and a mixed job wrong
// on principle — a promo house's PO would inherit "JP supplied the blanks" from
// a vendor record, and chase a Blank COGS receipt that never existed.

const { blanksModeForItems } = require('../../utils/apparel');

// Mirrors the resolution the two PO creators run.
const resolve = (items, vendorMode) => {
  const m = blanksModeForItems(items);
  return m == null ? vendorMode : m;
};

test('a promo PO does not expect a blanks receipt, even from a vendor that usually supplies', () => {
  const items = [{ description: 'Custom Lighters, 500 units' }];
  const blanksProvided = resolve(items, true);   // vendor remembers TRUE
  assert.strictEqual(blanksProvided, false, 'the items overrule the vendor');
  const po = new PurchaseOrder({ vendorName: 'Promo House', poNumber: 9, blanksProvided });
  assert.ok(!expectedReceiptCats({}, [po]).includes('Blank COGS'));
});

test('an apparel PO expects one, even from a vendor that usually does not', () => {
  const items = [{ description: 'Gildan 5000 Tee', taxExempt: true }];
  const blanksProvided = resolve(items, false);  // vendor remembers FALSE
  assert.strictEqual(blanksProvided, true);
  const po = new PurchaseOrder({ vendorName: 'Promo House', poNumber: 9, blanksProvided });
  assert.ok(expectedReceiptCats({}, [po]).includes('Blank COGS'));
});

test('with nothing to judge, the vendor still decides', () => {
  assert.strictEqual(resolve([], false), false);
  assert.strictEqual(resolve([], true), true);
});
