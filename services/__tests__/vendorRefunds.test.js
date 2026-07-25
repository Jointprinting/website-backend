// Supplier refunds miscategorised as customer refunds.
//
// 'Refund' in a P&L means money handed back to a CUSTOMER — contra-revenue, and
// that is how incomeContribution treats it. The same category was also used for
// money coming back FROM a supplier (an S&S sample return, a refunded Amtrak
// ticket), which is a cost reduction. Booking those as income/'Refund'
// understates revenue and overstates cost at once, so it understates profit by
// twice the amount.
//
// The party separates them, NOT the order number — an S&S sample return carries
// the order # it was bought for, yet S&S is a supplier. These tests pin that.

const test = require('node:test');
const assert = require('node:assert');

const { detectVendorRefunds } = require('../dataCleanup');

const CLIENTS = new Set(['happyleafdispensary', 'shaggysbaggy', 'bleuleafdispensary']);

const refund = (over = {}) => ({
  _id: 't1', type: 'income', category: 'Refund',
  party: 'Amtrak', amount: 52.5, orderNumber: '', date: '2026-03-01', ...over,
});

test('flags a supplier refund', () => {
  const out = detectVendorRefunds([refund()], CLIENTS, new Map());
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].party, 'Amtrak');
  assert.strictEqual(out[0].amount, 52.5);
});

test('leaves a real CUSTOMER refund alone — that IS contra-revenue', () => {
  const out = detectVendorRefunds(
    [refund({ party: "Shaggy's Baggy", amount: 220.91, orderNumber: '22' })],
    CLIENTS, new Map(),
  );
  assert.deepStrictEqual(out, []);
});

test('an order number does NOT make a supplier refund a customer refund', () => {
  // The exact trap: the S&S sample return carries order #43 because that's the
  // order the sample was bought for. S&S is the blank supplier, not the client.
  const out = detectVendorRefunds(
    [refund({ party: 'S&S Activewear', amount: 63.92, orderNumber: '43' })],
    CLIENTS, new Map(),
  );
  assert.strictEqual(out.length, 1, 'party decides, not the order number');
  assert.strictEqual(out[0].orderNumber, '43', 'the order # is still reported for context');
});

test('suggests the category that supplier\'s other spend sits in', () => {
  const hint = new Map([['ssactivewear', 'Blank COGS'], ['amtrak', 'Travel/Field']]);
  const out = detectVendorRefunds(
    [refund({ _id: 'a', party: 'S&S Activewear' }), refund({ _id: 'b', party: 'Amtrak' })],
    CLIENTS, hint,
  );
  assert.strictEqual(out.find((r) => r.txnId === 'a').suggestedCategory, 'Blank COGS');
  assert.strictEqual(out.find((r) => r.txnId === 'b').suggestedCategory, 'Travel/Field');
});

test('falls back to Other when the supplier has no spend history', () => {
  const out = detectVendorRefunds([refund({ party: 'Brand New Vendor' })], CLIENTS, new Map());
  assert.strictEqual(out[0].suggestedCategory, 'Other');
});

test('ignores everything that is not an income Refund row', () => {
  const rows = [
    refund({ _id: 'x', type: 'expense' }),                        // already an expense
    refund({ _id: 'y', category: 'Client Sales' }),               // a sale
    refund({ _id: 'z', type: 'expense', category: 'Blank COGS' }),// ordinary cost
  ];
  assert.deepStrictEqual(detectVendorRefunds(rows, CLIENTS, new Map()), []);
});

test('matches a client whose party is written "Contact, Company"', () => {
  // partyCompanyKeys resolves the company half — a refund to Nathan at Happy Leaf
  // is still a customer refund.
  const out = detectVendorRefunds(
    [refund({ party: 'Nathan Vigil, Happy Leaf Dispensary', amount: 100 })],
    CLIENTS, new Map(),
  );
  assert.deepStrictEqual(out, []);
});

test('the real 2026 ledger shape: five suppliers, one customer', () => {
  const rows = [
    refund({ _id: '1', party: 'S&S Activewear', amount: 63.92, orderNumber: '43' }),
    refund({ _id: '2', party: 'S&S Activewear', amount: 34.69, orderNumber: '43' }),
    refund({ _id: '3', party: 'Custom Patch Factory Sample Refund', amount: 48, orderNumber: '22' }),
    refund({ _id: '4', party: "Shaggy's Baggy", amount: 220.91, orderNumber: '22' }),
    refund({ _id: '5', party: 'Allianz Global Assistance', amount: 75 }),
    refund({ _id: '6', party: 'Amtrak', amount: 52.5 }),
  ];
  const out = detectVendorRefunds(rows, CLIENTS, new Map());
  assert.strictEqual(out.length, 5);
  assert.ok(!out.some((r) => r.txnId === '4'), "the client's refund is left as contra-revenue");
  const total = out.reduce((a, r) => a + r.amount, 0);
  assert.strictEqual(+total.toFixed(2), 274.11, 'the amount wrongly taken off revenue');
});

test('handles empty and missing input', () => {
  assert.deepStrictEqual(detectVendorRefunds([], CLIENTS, new Map()), []);
  assert.deepStrictEqual(detectVendorRefunds(null, null, null), []);
});

test('is idempotent — a re-booked row is no longer detected', () => {
  const row = refund();
  assert.strictEqual(detectVendorRefunds([row], CLIENTS, new Map()).length, 1);
  const fixed = { ...row, type: 'expense', category: 'Travel/Field', isCredit: true };
  assert.deepStrictEqual(detectVendorRefunds([fixed], CLIENTS, new Map()), []);
});
