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
