// controllers/__tests__/poCost.test.js
//
// Pure-logic checks for the consolidated PO cost-basis + line-selection module
// (utils/poCost) and the two seeders that now share it. No DB — every helper is
// pure, and the seeders are exercised with plain order objects.
//
//   node --test controllers/__tests__/poCost.test.js
//
// The KEY test is parity: the manual "New PO" seeder (_seedFromOrder, from the
// quote) and the confirmation seeder (_seedPoForGroup, from the approved
// confirmation) must produce an IDENTICAL vendor PO for the same job — same
// charges, same grand total — because that was the audit's root finding (~4
// disagreeing cost-basis implementations).

const test = require('node:test');
const assert = require('node:assert/strict');

const poCost = require('../../utils/poCost');
const {
  vendorKey, lineKey, chosenQuoteLines, costLineFromQuoteLine, costLineFromConfItem, buildPoLines,
} = poCost;
const {
  parseUnitCost, _seedFromOrder, _seedPoForGroup, _groupConfBySupplier, _quoteLineIndex,
} = require('../purchaseOrders');

const SHIP_TOS_M = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }];

// ── vendorKey: trim + collapse internal whitespace + lowercase (H1/H3) ───────
test('vendorKey normalizes whitespace + case identically everywhere', () => {
  assert.equal(vendorKey('Heritage Screen Printing'), 'heritage screen printing');
  assert.equal(vendorKey('  Heritage   Screen  Printing  '), 'heritage screen printing');
  assert.equal(vendorKey('heritage screen printing'), vendorKey('Heritage  Screen Printing'));
  assert.equal(vendorKey(''), '');
  assert.equal(vendorKey(null), '');
  assert.equal(vendorKey(undefined), '');
});

// ── lineKey: distinct print variants stay distinct (H4) ──────────────────────
test('lineKey separates two lines that differ only by print type / details', () => {
  const a = { styleCode: '3001', color: 'Black', printType: 'Screen Print', printDetails: '1 color front' };
  const b = { styleCode: '3001', color: 'Black', printType: 'Embroidery',   printDetails: 'left chest' };
  const c = { styleCode: '3001', color: 'Black', printType: 'Screen Print', printDetails: '2 color back' };
  assert.notEqual(lineKey(a), lineKey(b));   // different printType
  assert.notEqual(lineKey(a), lineKey(c));   // same type, different details
  assert.equal(lineKey(a), lineKey({ style: '3001', color: 'black', printType: 'screen print', printDetail: '1 color front' }));
});

// ── line selection mirrors chosenQuoteLines / computeQuoteTotals ─────────────
test('chosenQuoteLines keeps accepted + standalone + post-pick groups', () => {
  const lines = [
    { group: 'Tees', accepted: true,  styleCode: 'A' },
    { group: 'Tees', accepted: false, styleCode: 'B' },   // rejected alternative — dropped
    { group: '',     accepted: false, styleCode: 'C' },   // standalone — kept
    { group: 'Hats', accepted: false, styleCode: 'D' },   // group added after pick — kept
  ];
  const chosen = chosenQuoteLines(lines).map(l => l.styleCode);
  assert.deepEqual(chosen, ['A', 'C', 'D']);
});

test('chosenQuoteLines returns all lines before any pick', () => {
  const lines = [{ group: 'Tees', styleCode: 'A' }, { group: 'Tees', styleCode: 'B' }];
  assert.equal(chosenQuoteLines(lines).length, 2);
});

// ── blanksProvided is HONORED in the cost basis ──────────────────────────────
test('blank cost is excluded when the owner supplies blanks, included when not', () => {
  const line = { description: 'Tee', qty: 10, blankCost: 3, printCost: 2, setupCost: 40 };
  const supplied = costLineFromQuoteLine(line, true);    // JP supplies blanks
  const vendorBlanks = costLineFromQuoteLine(line, false); // vendor supplies blanks
  assert.equal(supplied.unitCost, 2);          // print only
  assert.equal(vendorBlanks.unitCost, 5);      // blank + print
  assert.equal(supplied.setupCost, 40);        // setup unaffected by blanksProvided
});

test('freight / shipping is excluded from the PO unit cost entirely', () => {
  // shippingCost on a quote line must never reach the PO cost.
  const line = { description: 'Tee', qty: 10, blankCost: 3, printCost: 2, setupCost: 40, shippingCost: 99 };
  const cl = costLineFromQuoteLine(line, false);
  assert.equal(cl.unitCost, 5);     // 3 + 2, no freight
  assert.equal(cl.setupCost, 40);   // freight is NOT folded into setup either
});

// ── setup is its OWN charge line, not folded into unit cost ──────────────────
test('buildPoLines emits a separate set-up fee charge', () => {
  const cl = costLineFromQuoteLine({ description: 'Tee', qty: 10, printCost: 2, setupCost: 40 }, true);
  const { charges, grandTotal } = buildPoLines([cl]);
  const labels = charges.map(c => c.label);
  assert.ok(labels.some(l => /\/unit \* 10 units$/.test(l)));
  assert.ok(labels.some(l => /set-up fee$/.test(l)));
  assert.equal(grandTotal, 2 * 10 + 40);   // 20 print + 40 setup = 60
});

// ── C3: zero-cost lines are flagged, not silently $0 ─────────────────────────
test('a qty line with no unit cost is counted as zero-cost (not a silent $0)', () => {
  const cl = { name: 'Mystery item', qty: 25, unitCost: 0, setupCost: 0, color: '', printType: '' };
  const { charges, zeroCostCount } = buildPoLines([cl]);
  assert.equal(zeroCostCount, 1);
  // No phantom $0 charge row is emitted for the unpriced line.
  assert.equal(charges.length, 0);
});

test('a setup-only line is not counted as zero-cost', () => {
  const cl = { name: 'Screens', qty: 0, unitCost: 0, setupCost: 50, color: '', printType: '' };
  const { charges, zeroCostCount } = buildPoLines([cl]);
  assert.equal(zeroCostCount, 0);
  assert.equal(charges.length, 1);   // the setup charge
});

// ── M1: parseUnitCost only reads a REAL unit-cost token ──────────────────────
test('parseUnitCost ignores a stray number in prose before /unit', () => {
  assert.equal(parseUnitCost('ship to 5/unit'), null);       // M1 target — bare int, no $
  assert.equal(parseUnitCost('ship to 5 /unit'), null);
  assert.equal(parseUnitCost('deliver 12/units to dock'), null);
  // Real tokens still parse.
  assert.equal(parseUnitCost('$5/unit'), 5);
  assert.equal(parseUnitCost('2.40/unit * 25 units'), 2.4);
  assert.equal(parseUnitCost('Tee: $2.40/unit * 25 units'), 2.4);
});

// ── H1/H3: grouping uses the normalized vendorKey ────────────────────────────
test('_groupConfBySupplier folds whitespace/case variants into one supplier', () => {
  const order = {
    printerName: '',
    confirmation: {
      items: [
        { printerName: 'Heritage Screen Printing', sizes: [{ label: 'M', qty: 5 }] },
        { printerName: 'heritage  screen printing', sizes: [{ label: 'L', qty: 5 }] },  // typo'd spacing/case
        { printerName: 'Promo Co', sizes: [{ label: 'OS', qty: 10 }] },
      ],
    },
  };
  const groups = _groupConfBySupplier(order);
  assert.equal(groups.length, 2);                    // Heritage variants merged
  const heritage = groups.find(g => vendorKey(g.vendorName) === 'heritage screen printing');
  assert.equal(heritage.items.length, 2);            // both items in one group
});

// ── THE PARITY TEST: manual seeder ≡ confirmation seeder for the same job ─────
test('manual (quote) and confirmation seeders produce an IDENTICAL vendor PO', () => {
  // One job: a single accepted tee line going to Heritage, JP supplies blanks.
  const quoteLine = {
    group: 'Tees', accepted: true,
    description: 'Bella 3001', styleCode: '3001', color: 'Black',
    printType: 'Screen Print', printDetails: '1 color front',
    supplier: 'Heritage', qty: 25,
    blankCost: 3, printCost: 2, setupCost: 40, shippingCost: 50,   // freight present — must be excluded
  };
  const order = {
    printerName: 'Heritage', companyName: 'Acme', clientName: 'Jane',
    quoteLines: [quoteLine],
    confirmation: {
      shipping: { name: 'Acme', attention: 'Jane', streetAddress: '', cityStateZip: '' },
      // The confirmation item as the builder seeds it from the quote line: it
      // carries the bundled unitCost AND the style|color|print identity that lets
      // the PO recover granular cost. printerName routes it to Heritage.
      items: [{
        productName: '', brandName: 'Bella', styleCode: '3001', color: 'Black',
        printType: 'Screen Print', printDetails: '1 color front', printerName: 'Heritage',
        unitCost: 3 + 2 + (40 + 50) / 25,   // the coarse bundled cost the confirmation stores
        sizes: [{ label: 'M', qty: 10, unitPrice: 12 }, { label: 'L', qty: 15, unitPrice: 12 }],
      }],
    },
  };

  const blanksProvided = true;   // JP supplies blanks (the 99% case)

  // Manual path: from the quote.
  const manual = _seedFromOrder(order, blanksProvided);

  // Confirmation path: group by supplier, recover granular cost from the quote.
  const quoteIdx = _quoteLineIndex(order);
  const group = _groupConfBySupplier(order)[0];
  const conf = _seedPoForGroup(order, group.vendorName, group.items, blanksProvided, quoteIdx);

  // Charges (the money) must be byte-identical: blank EXCLUDED (blanksProvided),
  // freight EXCLUDED, setup as its own line. unit = printCost = $2; 25 units.
  assert.deepEqual(conf.charges, manual.charges);
  assert.equal(manual.grandTotal, conf.grandTotal);
  assert.equal(manual.grandTotal, 2 * 25 + 40);   // $50 print + $40 setup = $90 (NO blank, NO freight)
  // Neither path leaked freight into the total.
  assert.ok(!JSON.stringify(manual.charges).includes('50.00') || manual.grandTotal === 90);
});

test('parity holds when the vendor supplies blanks (blanksProvided=false)', () => {
  const quoteLine = {
    accepted: false, group: '', description: 'Tee', styleCode: 'T1', color: 'White',
    printType: 'DTG', printDetails: '', supplier: 'PrintCo', qty: 20,
    blankCost: 4, printCost: 1.5, setupCost: 0, shippingCost: 30,
  };
  const order = {
    printerName: 'PrintCo', companyName: 'Co', clientName: 'X',
    quoteLines: [quoteLine],
    confirmation: {
      shipping: {},
      items: [{
        brandName: 'Tee', styleCode: 'T1', color: 'White', printType: 'DTG', printDetails: '',
        printerName: 'PrintCo', unitCost: 4 + 1.5,
        sizes: [{ label: 'OS', qty: 20, unitPrice: 10 }],
      }],
    },
  };
  const manual = _seedFromOrder(order, false);
  const conf = _seedPoForGroup(order, _groupConfBySupplier(order)[0].vendorName, _groupConfBySupplier(order)[0].items, false, _quoteLineIndex(order));
  // The MONEY must match exactly (charge amounts + grand total) — the display
  // name can differ because the quote carries a free-text description while the
  // confirmation carries structured brand/style; the audit is about vendor
  // TOTALS, not the label text.
  assert.deepEqual(conf.charges.map(c => c.amount), manual.charges.map(c => c.amount));
  assert.equal(manual.grandTotal, conf.grandTotal);
  assert.equal(manual.grandTotal, (4 + 1.5) * 20);   // blank+print, freight excluded
});

// ── M4: a split that doesn't reconcile to item qty is flagged (not silent) ───
test('confirmation PO flags an item whose allocations do not sum to its qty', () => {
  const order = {
    printerName: 'Heritage',
    quoteLines: [],
    confirmation: {
      shipping: {}, shipTos: SHIP_TOS_M,
      items: [
        // 25 total, but only 20 allocated → mismatch.
        { productName: 'Tee', printerName: 'Heritage', unitCost: 4,
          sizes: [{ label: 'M', qty: 10 }, { label: 'L', qty: 15 }],
          allocations: [{ key: 'a', qty: 12 }, { key: 'b', qty: 8 }] },
        // balanced item — must NOT be flagged.
        { productName: 'Hat', printerName: 'Heritage', unitCost: 3,
          sizes: [{ label: 'OS', qty: 10 }],
          allocations: [{ key: 'a', qty: 6 }, { key: 'b', qty: 4 }] },
      ],
    },
  };
  const seeded = _seedPoForGroup(order, 'Heritage', order.confirmation.items, true, _quoteLineIndex(order));
  assert.equal(seeded.allocMismatchCount, 1);   // only the unbalanced one
});

test('an unsplit item (no allocations) is never an allocation mismatch', () => {
  const order = {
    confirmation: {
      shipping: {}, shipTos: SHIP_TOS_M,
      items: [{ productName: 'Tee', unitCost: 4, sizes: [{ label: 'M', qty: 25 }] }],
    },
  };
  const seeded = _seedPoForGroup(order, 'Heritage', order.confirmation.items, true, new Map());
  assert.equal(seeded.allocMismatchCount, 0);
});

// ── confirmation item with no quote-line match falls back, still flags $0 ────
test('hand-added confirmation item with no cost yields a flagged zero-cost line', () => {
  const order = {
    printerName: 'Heritage',
    quoteLines: [],   // no quote lines to match against
    confirmation: {
      shipping: {},
      items: [{ productName: 'Hand-added widget', printerName: 'Heritage', sizes: [{ label: 'OS', qty: 30 }] }],
    },
  };
  const seeded = _seedPoForGroup(order, 'Heritage', order.confirmation.items, true, _quoteLineIndex(order));
  assert.equal(seeded.zeroCostCount, 1);
  assert.equal(seeded.charges.length, 0);   // no silent $0 charge
  assert.equal(seeded.grandTotal, 0);
});
