// services/__tests__/commissionCostGate.test.js
//
//   node --test services/__tests__/commissionCostGate.test.js
//
// Commission is a share of PROFIT. An agent logs a sale through the portal with
// a value and no cost — the portal deliberately never shows or collects cost —
// so `cogs` stays 0, no receipts are booked, and orderMoney reads profit = the
// full sale price.
//
// The agent's statement was therefore calling a percentage of REVENUE an earned
// balance. On a brokered job that is roughly triple what is owed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { earnedState, pendingReason, commissionForOrder, normalizeConfig } = require('../commission');

const soldAndPaid = { status: 'delivered', paid: true };
const knownCost   = { costUnknown: false };
const noCost      = { costUnknown: true };

test('delivered and paid with a known cost is earned, as before', () => {
  assert.equal(earnedState(soldAndPaid, knownCost), 'earned');
});

test('THE BUG: delivered and paid with NO known cost is a forecast, not a balance', () => {
  assert.equal(earnedState(soldAndPaid, noCost), 'pending');
});

test('it says WHY, so the agent is not left guessing at a number that moved', () => {
  assert.match(pendingReason(soldAndPaid, noCost), /cost/i);
  assert.equal(pendingReason(soldAndPaid, knownCost), '');
});

test('an undelivered order is pending for the ordinary reason, with no extra excuse', () => {
  assert.equal(earnedState({ status: 'placed', paid: true }, noCost), 'pending');
  assert.equal(pendingReason({ status: 'placed', paid: true }, noCost), '');
});

test('callers that pass no money argument behave exactly as they did', () => {
  // The signature had to stay backward-compatible: a caller that has not
  // computed cost is not the one that can judge this.
  assert.equal(earnedState(soldAndPaid), 'earned');
  assert.equal(earnedState({ status: 'placed' }), 'pending');
});

test('the size of the error this prevents', () => {
  // A $5,000 agent-logged sale. Real COGS on a brokered job might be $3,500.
  const cfg = normalizeConfig({});
  const onRevenue = commissionForOrder({ profit: 5000, kind: 'self', config: cfg, state: 'earned' });
  const onProfit  = commissionForOrder({ profit: 1500, kind: 'self', config: cfg, state: 'earned' });
  // Same rate, wildly different money — and the first was being presented as owed.
  assert.equal(onRevenue.ratePct, onProfit.ratePct);
  assert.ok(onRevenue.commission > onProfit.commission * 3,
    `${onRevenue.commission} should be >3x ${onProfit.commission}`);
});

test('a costless order cannot inflate the tier ladder either', () => {
  // Both callers only add to lifetimeProfit when state === 'earned'. Holding
  // these at pending therefore also stops a 100%-margin order promoting the
  // agent to a higher commission rate — which would have overpaid every
  // LATER order too.
  assert.notEqual(earnedState(soldAndPaid, noCost), 'earned');
});

test('nothing here pays a negative or invents a margin', () => {
  // The fix deliberately does NOT guess a default cost. An assumed margin is a
  // number nobody agreed to; "not yet known" is the truth.
  const cfg = normalizeConfig({});
  assert.equal(commissionForOrder({ profit: -200, kind: 'self', config: cfg }).commission, 0);
});
