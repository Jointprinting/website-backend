// controllers/__tests__/vendorDatabase.test.js
//
// Pure-logic checks (no DB, no extra dev deps) for the connected supplier
// database work:
//   1. per-vendor "next PO #" seed/bump — the owner-set start (Vendor.nextPoStart)
//      wins as a FLOOR while the atomic counter stays collision-safe;
//   2. the vendor-card aggregation — POs + orders + receipts rolled up for one
//      vendor, leading-zero-safe, with the ledger signing rule;
//   3. the receipt→vendor learning decision — when an order↔printer link is
//      remembered (conservative: named expense party + real order # only).
//
//   node --test controllers/__tests__/vendorDatabase.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { _flooredNext, _flooredSeq, _numOf, _slug, _counterId } = require('../../utils/sequence');
const { aggregateVendorCard, _vendorOrderKeys } = require('../purchaseOrders');
const { vendorOrderLearnPlan } = require('../receipts');

// ───────────────────────────── 1. NUMBERING ─────────────────────────────────
// The single rule the owner-set start enforces: the next assigned PO number is
// max(stored counter + 1, owner start). The atomic $inc still owns uniqueness;
// the floor only lifts the FIRST number when the app's counter lags the owner's
// real Google-Docs run (Heritage saw #004 in-app but is really up to ~8).

test('flooredNext: owner start wins when it is ahead of the counter', () => {
  // Heritage: app counter saw up to #004 (seq 4), owner sets next start = 9.
  assert.equal(_flooredNext(4, 9), 9);
  // Exactly at the boundary — start equals the natural next-up.
  assert.equal(_flooredNext(8, 9), 9);
});

test('flooredNext: counter wins once it has passed the owner start (no regression)', () => {
  // Owner set 9 earlier; we've since issued up to #012. Next must be #013, NOT 9
  // — the floor must never pull an advanced sequence backwards.
  assert.equal(_flooredNext(12, 9), 13);
  // No / zero / junk floor → plain next-up.
  assert.equal(_flooredNext(7, 0), 8);
  assert.equal(_flooredNext(7, null), 8);
  assert.equal(_flooredNext(7, undefined), 8);
  assert.equal(_flooredNext(7, -5), 8);
  assert.equal(_flooredNext(7, 'abc'), 8);
});

test('flooredNext: brand-new vendor (seq 0) starts at #001, or at the owner start', () => {
  assert.equal(_flooredNext(0), 1);
  assert.equal(_flooredNext(0, 9), 9);   // a fresh printer Nate wants to start at 9
});

test('flooredSeq: raises the counter to start-1 so the NEXT $inc yields the start', () => {
  // Setting start=9 floors the counter to 8 (so $inc → 9), never moving it back.
  assert.equal(_flooredSeq(4, 9), 8);
  assert.equal(_flooredSeq(0, 9), 8);
  // Counter already past the floor stays put (collision-safe; no regression).
  assert.equal(_flooredSeq(12, 9), 12);
  // No floor → unchanged.
  assert.equal(_flooredSeq(5, 0), 5);
  assert.equal(_flooredSeq(5), 5);
});

test('flooredNext and flooredSeq agree: the issued number after a floor is the start', () => {
  // The realized number is (flooredSeq + 1). It must equal flooredNext for any
  // (seq, floor) — the peek the UI shows and the number that actually gets issued
  // can never disagree.
  for (const seq of [0, 1, 4, 8, 9, 12, 50]) {
    for (const floor of [0, 1, 5, 9, 13, 100]) {
      assert.equal(_flooredSeq(seq, floor) + 1, _flooredNext(seq, floor),
        `seq=${seq} floor=${floor}`);
    }
  }
});

test('numOf parses the leading numeric of a stored PO number', () => {
  assert.equal(_numOf('#007'), 7);
  assert.equal(_numOf('#012'), 12);
  assert.equal(_numOf('22-1'), 22);
  assert.equal(_numOf(''), 0);
  assert.equal(_numOf(null), 0);
});

test('per-vendor counter id is slug-scoped so vendors never share a sequence', () => {
  // "Heritage", "heritage", "Heritage  Screen Printing" must NOT all collapse —
  // but case/whitespace variants of the SAME name must. (Matches utils/poCost
  // vendorKey semantics for the bits that matter.)
  assert.equal(_counterId('po', 'Heritage'), _counterId('po', 'heritage'));
  assert.equal(_counterId('po', 'Heritage  Screen  Printing'), 'po:heritage-screen-printing');
  assert.notEqual(_counterId('po', 'Heritage'), _counterId('po', 'Heritage Screen Printing'));
  // No scope → the shared 'po' counter (a vendorless draft still numbers).
  assert.equal(_counterId('po', ''), 'po');
  assert.equal(_slug('Heritage Screen Printing'), 'heritage-screen-printing');
});

// ───────────────────────── 2. VENDOR-CARD AGGREGATION ────────────────────────

const oid = (s) => s; // string ids are fine for the pure aggregator

test('_vendorOrderKeys unions PO orders + receipt orders + remembered hints, leading-zero-safe', () => {
  const vendor = { vendorOrders: [{ orderNumber: '0000099' }, { orderNumber: 'PO-7' }] };
  const posByOrderNum = { 21: [{}], 22: [{}] };
  const txns = [{ orderNumber: '021' }, { orderNumber: '0000023' }, { orderNumber: '' }];
  const keys = _vendorOrderKeys(vendor, posByOrderNum, txns).sort((a, b) => Number(a) - Number(b));
  // 21 appears via both a PO and a receipt (leading-zero variants) → ONE key.
  assert.deepEqual(keys, ['7', '21', '22', '23', '99']);
});

test('aggregateVendorCard rolls up POs, orders, receipts + totals for one vendor', () => {
  const vendor = { _id: 'v1', name: 'Heritage', nextPoStart: 0, vendorOrders: [] };
  const vendorPos = [
    { _id: 'p1', poNumber: '#009', grandTotal: 302, orderId: oid('o21'), date: new Date('2026-02-01') },
    { _id: 'p2', poNumber: '#010', grandTotal: 150, orderId: oid('o22'), date: new Date('2026-03-01') },
  ];
  // Actual money paid to Heritage from the receipts/ledger. A "0000021" row and a
  // "21" row are the SAME order. One credit (a supplier refund) nets spend DOWN.
  const txns = [
    { _id: 't1', type: 'expense', party: 'Heritage', amount: 300, isCredit: false, category: 'Printer COGS', orderNumber: '0000021', receiptUrl: 'r.pdf' },
    { _id: 't2', type: 'expense', party: 'Heritage', amount: 25,  isCredit: true,  category: 'Printer COGS', orderNumber: '21' },
    { _id: 't3', type: 'expense', party: 'Heritage', amount: 150, isCredit: false, category: 'Printer COGS', orderNumber: '022' },
  ];
  const connectedOrders = [
    { _id: 'o21', orderNumber: '0000021', projectNumber: 'P-21', companyName: 'Acme', totalValue: 600, paid: true,  status: 'delivered' },
    { _id: 'o22', orderNumber: '22',      projectNumber: 'P-22', companyName: 'Beta', totalValue: 400, paid: false, status: 'placed' },
  ];
  const orderById = new Map(connectedOrders.map((o) => [String(o._id), o]));

  const card = aggregateVendorCard({ vendor, vendorPos, txns, connectedOrders, orderById });

  // Totals: 2 POs worth $452; lifetime spend = 300 - 25 + 150 = 425 (credit nets).
  assert.equal(card.totals.poCount, 2);
  assert.equal(card.totals.poTotal, 452);
  assert.equal(card.totals.lifetimeSpend, 425);
  assert.equal(card.totals.orderCount, 2);

  // Per-order rollup, newest order # first. Order 22 then 21.
  assert.deepEqual(card.orders.map((o) => o.orderNumber), ['22', '21']);
  const o21 = card.orders.find((o) => o.orderNumber === '21');
  assert.equal(o21.company, 'Acme');
  assert.equal(o21.spend, 275);                 // 300 - 25, leading-zero-safe match
  assert.deepEqual(o21.pos.map((p) => p.poNumber), ['#009']);
  const o22 = card.orders.find((o) => o.orderNumber === '22');
  assert.equal(o22.spend, 150);
  assert.equal(o22.paid, false);

  // PO list carries the canonical order # + project for the card's links.
  const p1 = card.pos.find((p) => p._id === 'p1');
  assert.equal(p1.orderNumber, '21');
  assert.equal(p1.projectNumber, 'P-21');
  // Transactions list normalizes order numbers + flags receipts.
  assert.equal(card.transactions.find((t) => t._id === 't1').orderNumber, '21');
  assert.equal(card.transactions.find((t) => t._id === 't1').hasReceipt, true);
  assert.equal(card.transactions.find((t) => t._id === 't2').hasReceipt, false);
});

test('aggregateVendorCard surfaces a hint-only order (receipt paid, no PO yet)', () => {
  // The learned hint says Heritage did order #50, and a receipt confirms the spend,
  // but no PO was ever cut. The card must still show order #50 with its spend so
  // the connection isn't lost.
  const vendor = { _id: 'v1', name: 'Heritage', vendorOrders: [{ orderNumber: '50' }] };
  const txns = [{ _id: 't', type: 'expense', party: 'Heritage', amount: 80, orderNumber: '0050', category: 'Printer COGS' }];
  const connectedOrders = [{ _id: 'o50', orderNumber: '00050', companyName: 'Gamma', totalValue: 200, paid: false }];
  const card = aggregateVendorCard({ vendor, vendorPos: [], txns, connectedOrders, orderById: new Map([['o50', connectedOrders[0]]]) });
  assert.equal(card.totals.poCount, 0);
  assert.equal(card.totals.orderCount, 1);
  const o50 = card.orders[0];
  assert.equal(o50.orderNumber, '50');
  assert.equal(o50.company, 'Gamma');
  assert.equal(o50.spend, 80);
  assert.deepEqual(o50.pos, []);
});

test('aggregateVendorCard is crash-safe on empty / missing inputs', () => {
  const card = aggregateVendorCard({ vendor: { name: 'X' }, vendorPos: [], txns: [], connectedOrders: [], orderById: new Map() });
  assert.equal(card.totals.poCount, 0);
  assert.equal(card.totals.lifetimeSpend, 0);
  assert.equal(card.totals.orderCount, 0);
  assert.equal(card.totals.lastUsed, null);
  assert.deepEqual(card.orders, []);
  // Tolerates undefined arrays entirely.
  const card2 = aggregateVendorCard({ vendor: {}, orderById: {} });
  assert.equal(card2.totals.poCount, 0);
});

// ──────────────────────── 3. RECEIPT→VENDOR LEARNING ─────────────────────────

test('vendorOrderLearnPlan: learns a named expense party with a real order #', () => {
  assert.deepEqual(vendorOrderLearnPlan('Heritage Screen Printing', 'expense', '#0000021'),
    { name: 'Heritage Screen Printing', key: '21' });
  // Leading zeros / decoration on the order # are normalized to the canonical key.
  assert.deepEqual(vendorOrderLearnPlan('UPS', 'expense', 'PO-007'), { name: 'UPS', key: '7' });
});

test('vendorOrderLearnPlan: skips income, blank party, no order #, and self', () => {
  // INCOME (our own sales invoice) — the party is the client, never a printer.
  assert.equal(vendorOrderLearnPlan('Acme', 'income', '21'), null);
  // No vendor named — nothing to learn.
  assert.equal(vendorOrderLearnPlan('', 'expense', '21'), null);
  assert.equal(vendorOrderLearnPlan('   ', 'expense', '21'), null);
  // No / non-numeric order # — can't link it to an order.
  assert.equal(vendorOrderLearnPlan('Heritage', 'expense', ''), null);
  assert.equal(vendorOrderLearnPlan('Heritage', 'expense', 'no-digits'), null);
  // Self (Joint Printing as a party) is never a vendor — guard against the bug.
  assert.equal(vendorOrderLearnPlan('Joint Printing', 'expense', '21'), null);
  assert.equal(vendorOrderLearnPlan('Joint Printing LLC', 'expense', '21'), null);
});
