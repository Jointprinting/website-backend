// controllers/__tests__/safeConfirmation.test.js
//
// The client-facing confirmation must NEVER carry internal cost/routing data.
// _safeConfirmation is a blocklist over each item — so every internal field it
// gains has to be added to the strip. This pins that the cost (unitCost), the
// supplier (printerName), and the new routing/recipe fields (printerKey,
// printSpec) are all removed, while the client-rendered fields survive.

const { test } = require('node:test');
const assert = require('node:assert');
const { _safeConfirmation } = require('../approval');

test('_safeConfirmation strips every internal item field, keeps the rest', () => {
  const conf = {
    customLines: [{ text: 'Rush fee' }],
    items: [{
      // client-facing — must survive
      productName: 'Rolling Trays', brandName: 'Rolling', styleCode: 'RT-1',
      printType: 'Screen Print', printDetails: '1 color front', color: 'Black',
      turnaroundWeeks: 2, sizes: [{ label: 'OS', qty: 100, unitPrice: 4.5 }],
      // internal — must be stripped
      unitCost: 2.13, printerName: 'Heritage Screen Printing',
      printerKey: 'heritage', printSpec: { method: 'Screen Print', shade: 'light', areas: [{ label: 'front', colors: 1 }] },
    }],
  };
  const safe = _safeConfirmation(conf);
  const it = safe.items[0];

  // Internal fields gone.
  assert.ok(!('unitCost' in it), 'unitCost must be stripped');
  assert.ok(!('printerName' in it), 'printerName must be stripped');
  assert.ok(!('printerKey' in it), 'printerKey must be stripped');
  assert.ok(!('printSpec' in it), 'printSpec must be stripped');

  // Client-rendered fields survive.
  assert.strictEqual(it.productName, 'Rolling Trays');
  assert.strictEqual(it.printType, 'Screen Print');
  assert.strictEqual(it.turnaroundWeeks, 2);
  assert.deepStrictEqual(it.sizes, [{ label: 'OS', qty: 100, unitPrice: 4.5 }]);
  // Non-item content passes through untouched.
  assert.deepStrictEqual(safe.customLines, [{ text: 'Rush fee' }]);
});

test('_safeConfirmation is null-safe and handles missing items', () => {
  assert.strictEqual(_safeConfirmation(null), null);
  assert.deepStrictEqual(_safeConfirmation({ customLines: [] }), { customLines: [] });
});
