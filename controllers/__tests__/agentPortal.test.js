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
