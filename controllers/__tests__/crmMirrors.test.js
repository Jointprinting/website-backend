// controllers/__tests__/crmMirrors.test.js
//
// SYNC GUARD for the CRM constants the frontend mirrors. The twin test lives at
// website-frontend/src/screens/studio/crm/_crm.sync.test.js and pins the SAME
// literals — change either side without the other and one suite goes red.
//
//   node --test controllers/__tests__/crmMirrors.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const Client = require('../../models/Client');
const { STAGE_PROBABILITY, BOARD_COLUMNS, BOARD_CLOSED_COLUMNS, BOARD_PROBABILITY } = require('../crm');

test('Client stage enum matches the agreed vocabulary (order matters)', () => {
  const enumVals = Client.schema.path('stage').enumValues;
  assert.deepEqual(enumVals, ['lead', 'contacted', 'awaiting_details', 'quoting', 'won', 'customer', 'lost', 'dormant']);
});

test('STAGE_PROBABILITY matches the agreed close-rates the frontend mirrors', () => {
  assert.deepEqual(STAGE_PROBABILITY, {
    lead: 0.1, contacted: 0.25, awaiting_details: 0.35, quoting: 0.5,
    won: 1, customer: 1, lost: 0, dormant: 0,
  });
});

test('board columns + probabilities match the frontend mirror (order matters)', () => {
  assert.deepEqual(BOARD_COLUMNS, ['lead', 'contacted', 'awaiting_details', 'quoting', 'approval', 'production', 'shipped', 'delivered']);
  assert.deepEqual(BOARD_CLOSED_COLUMNS, ['lost', 'dormant', 'cancelled']);
  assert.deepEqual(BOARD_PROBABILITY, {
    lead: 0.1, contacted: 0.25, awaiting_details: 0.35, quoting: 0.5, approval: 0.8,
    production: 0.9, shipped: 0.95, delivered: 1,
    lost: 0, dormant: 0, cancelled: 0,
  });
});
