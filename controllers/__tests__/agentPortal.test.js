// controllers/__tests__/agentPortal.test.js
//
// Pure bits of the agent portal (no DB): the order shape an agent receives NEVER
// carries cost/margin/receipt data, the lead shape trims the log, and the
// settable order-status list is sane.
//   node --test controllers/__tests__/agentPortal.test.js

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-abc123';

const test = require('node:test');
const assert = require('node:assert/strict');

const { agentOrderShape, agentLeadShape, AGENT_ORDER_STATUSES } = require('../agentPortal');

test('agentOrderShape NEVER exposes cost/margin fields', () => {
  const shaped = agentOrderShape({
    _id: 'oid1', orderNumber: '21', projectNumber: '105', companyName: 'Green Co',
    clientName: 'Mia', companyKey: 'greenco', status: 'placed', totalValue: 1800,
    cogs: 950, actualCost: 900, actualMargin: 0.5, // <- must not survive
    orderDate: new Date(), notes: 'rush',
  });
  const json = JSON.stringify(shaped);
  assert.doesNotMatch(json, /cogs|actualCost|actualMargin|margin|receipt/i);
  assert.equal(shaped.id, 'oid1');
  assert.equal(shaped.totalValue, 1800);
  assert.equal(shaped.status, 'placed');
});

test('agentLeadShape trims the log to the last 30 touches', () => {
  const log = Array.from({ length: 50 }, (_, i) => ({ at: new Date(), text: `t${i}`, kind: 'note' }));
  const shaped = agentLeadShape({ companyKey: 'k', companyName: 'Co', stage: 'contacted', dealValue: 500, log });
  assert.equal(shaped.log.length, 30);
  assert.equal(shaped.log[29].text, 't49'); // keeps the most recent
  assert.equal(shaped.stage, 'contacted');
  assert.equal(shaped.dealValue, 500);
});

test('agentLeadShape tolerates a bare record (no arrays)', () => {
  const shaped = agentLeadShape({ companyKey: 'k', companyName: 'Solo' });
  assert.deepEqual(shaped.contacts, []);
  assert.deepEqual(shaped.log, []);
  assert.equal(shaped.stage, 'lead');
});

test('AGENT_ORDER_STATUSES is the coarse sales lifecycle, no owner-only steps', () => {
  assert.ok(AGENT_ORDER_STATUSES.includes('quoted'));
  assert.ok(AGENT_ORDER_STATUSES.includes('delivered'));
  assert.ok(AGENT_ORDER_STATUSES.includes('cancelled'));
  // Every value is a non-empty string; no dupes.
  assert.equal(new Set(AGENT_ORDER_STATUSES).size, AGENT_ORDER_STATUSES.length);
});

// ── orderMoney: actual-first, honest estimate fallback ───────────────────────
//
// The earnings tab is the ONE place the portal shows an agent a cost figure, so
// its fallback rules are worth pinning: a job with no booked receipts must not
// read as pure profit, and a booked ledger must always beat the quote estimate.

const { orderMoney } = require('../agentPortal');

test('orderMoney prefers the booked ledger over the quote estimate', () => {
  const m = orderMoney(
    { totalValue: 2000, cogs: 1500 },
    [
      { type: 'income',  category: 'Client Sales',  amount: 1906.34 },
      { type: 'expense', category: 'Blank COGS',    amount: 639.50 },
      { type: 'expense', category: 'Printer COGS',  amount: 825.55 },
      { type: 'expense', category: 'Shipping',      amount: 93.07 },
      { type: 'expense', category: 'Processing Fee', amount: 57.00 },
    ],
  );
  // The real order #000031 (Cannapi) — reconciles to the owner's P&L exactly.
  assert.equal(m.revenue, 1906.34);
  assert.equal(m.cost, 1615.12);
  assert.equal(m.profit, 291.22);
  assert.equal(m.costIsEstimate, false);
  assert.equal(m.costUnknown, false);
});

test('orderMoney falls back to the quote estimate and SAYS it is an estimate', () => {
  const m = orderMoney({ totalValue: 1200, cogs: 900 }, []);
  assert.equal(m.revenue, 1200);
  assert.equal(m.cost, 900);
  assert.equal(m.profit, 300);
  assert.equal(m.costIsEstimate, true, 'the UI must be able to badge this');
});

test('orderMoney flags a job with NO cost information at all', () => {
  // Without this flag the row would read as 100% profit, which is never real
  // for a broker and would inflate the agent's forecast.
  const m = orderMoney({ totalValue: 800, cogs: 0 }, []);
  assert.equal(m.costUnknown, true);
  assert.equal(m.cost, 0);
});

test('orderMoney nets a supplier credit down instead of adding it', () => {
  const m = orderMoney({ totalValue: 0, cogs: 0 }, [
    { type: 'income',  category: 'Client Sales', amount: 1000 },
    { type: 'expense', category: 'Printer COGS', amount: 400 },
    { type: 'expense', category: 'Printer COGS', amount: 100, isCredit: true },
  ]);
  assert.equal(m.cost, 300, 'a credit subtracts');
  assert.equal(m.profit, 700);
});

test('orderMoney treats a refund as contra-revenue', () => {
  const m = orderMoney({ totalValue: 0, cogs: 0 }, [
    { type: 'income',  category: 'Client Sales', amount: 1000 },
    { type: 'income',  category: 'Refund',       amount: 250 },
    { type: 'expense', category: 'Blank COGS',   amount: 300 },
  ]);
  assert.equal(m.revenue, 750);
  assert.equal(m.profit, 450);
});
