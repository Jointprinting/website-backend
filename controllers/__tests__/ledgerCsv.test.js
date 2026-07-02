// controllers/__tests__/ledgerCsv.test.js
//
// Pins the accountant-facing CSV export (buildLedgerCsv — pure, no DB):
// column set, signed-amount + credit conventions, cash direction, escaping,
// and dirty-data resilience. Runs on Node's built-in test runner:
//
//   node --test controllers/__tests__/ledgerCsv.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildLedgerCsv } = require('../finances');

const HEADER = 'Date,Type,Category,Customer/Vendor,Description,Amount,Money In/Out,Credit/Refund,Order #,Project #,Invoice #,Payment Method,Receipt Link,QB Synced';

const base = {
  date: '2026-03-05T00:00:00.000Z', type: 'expense', category: 'Printer COGS',
  party: 'Heritage', description: 'run of 120 tees', amount: 431.5, isCredit: false,
  orderNumber: '1049', projectNumber: '140', invoiceNumber: '', paymentMethod: '',
  receiptUrl: 'https://r2.example/abc.pdf', qbSynced: false,
};

test('header carries every accountant column (and the import-matcher tokens)', () => {
  const csv = buildLedgerCsv([]);
  assert.equal(csv, HEADER);
  // the /import matcher finds columns by these tokens — keep them present
  for (const tok of ['date', 'type', 'category', 'customer', 'description', 'amount', 'qb']) {
    assert.ok(HEADER.toLowerCase().includes(tok), `header must contain "${tok}"`);
  }
});

test('an expense row: two-decimal amount, Money Out, references + receipt link', () => {
  const csv = buildLedgerCsv([base]);
  const row = csv.split('\n')[1];
  assert.equal(row, '2026-03-05,Expense,Printer COGS,Heritage,run of 120 tees,431.50,Out,,1049,140,,,https://r2.example/abc.pdf,No');
});

test('income is Money In; an income credit (customer refund) is negative and Money Out', () => {
  const csv = buildLedgerCsv([
    { ...base, type: 'income', category: 'Customer Sales', party: 'Acme', amount: 413.65, paymentMethod: 'cc', qbSynced: true },
    { ...base, type: 'income', category: 'Refund', party: 'Acme', amount: 50, isCredit: true },
  ]);
  const [, sale, refund] = csv.split('\n');
  assert.ok(sale.includes(',Income,') && sale.includes(',413.65,In,,') && sale.includes(',Credit card,'));
  assert.ok(sale.endsWith(',Yes'));
  assert.ok(refund.includes(',-50.00,Out,Yes,'), `refund row wrong: ${refund}`);
});

test('an expense credit (supplier refund) is negative and Money In', () => {
  const csv = buildLedgerCsv([{ ...base, amount: 25, isCredit: true }]);
  assert.ok(csv.split('\n')[1].includes(',-25.00,In,Yes,'));
});

test('commas and quotes in text cells are CSV-escaped', () => {
  const csv = buildLedgerCsv([{ ...base, party: 'Heritage, Inc.', description: 'says "rush job"' }]);
  const row = csv.split('\n')[1];
  assert.ok(row.includes('"Heritage, Inc."'));
  assert.ok(row.includes('"says ""rush job"""'));
});

test('dirty data never breaks the file: null row skipped, bad date → blank cell', () => {
  const csv = buildLedgerCsv([null, { ...base, date: 'not-a-date' }]);
  const lines = csv.split('\n');
  assert.equal(lines.length, 2);            // header + the one real row
  assert.ok(lines[1].startsWith(',Expense,'));
});
