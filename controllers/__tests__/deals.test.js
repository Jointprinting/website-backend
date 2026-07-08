// controllers/__tests__/deals.test.js
//
// Pure-logic checks for the deal pipeline (no DB):
//   node --test controllers/__tests__/deals.test.js
//
// The load-bearing behavior: the "seed deals from orders" migration must be
// IDEMPOTENT (re-running creates nothing new) and ADDITIVE (it only ever
// produces deals to insert — it can't express a mutation of an Order/Client),
// which is what makes it fully reversible by deleting the batch.

const test = require('node:test');
const assert = require('node:assert/strict');

const Deal = require('../../models/Deal');
const { isClientFromDeals, deriveBusinessStatus, planMigration } = require('../../services/dealService');
const { sanitizeDeal } = require('../deals');

// ── Order status → deal stage ────────────────────────────────────────────────
test('dealStageFromOrderStatus maps order reality to the pipeline', () => {
  assert.equal(Deal.dealStageFromOrderStatus('quoted'), 'quoted');
  assert.equal(Deal.dealStageFromOrderStatus('approved'), 'quoted');
  assert.equal(Deal.dealStageFromOrderStatus('placed'), 'won');
  assert.equal(Deal.dealStageFromOrderStatus('in_production'), 'won');
  assert.equal(Deal.dealStageFromOrderStatus('shipped'), 'won');
  assert.equal(Deal.dealStageFromOrderStatus('delivered'), 'won');
  assert.equal(Deal.dealStageFromOrderStatus('cancelled'), 'lost');
  assert.equal(Deal.dealStageFromOrderStatus(''), 'quoted');       // unknown → open
});

// ── Derive-client (≥1 won deal = client) ─────────────────────────────────────
test('isClientFromDeals: true only with a live won deal', () => {
  assert.equal(isClientFromDeals([{ stage: 'won' }]), true);
  assert.equal(isClientFromDeals([{ stage: 'quoted' }, { stage: 'lost' }]), false);
  assert.equal(isClientFromDeals([{ stage: 'won', archived: true }]), false); // archived doesn't count
  assert.equal(isClientFromDeals([]), false);
  assert.equal(isClientFromDeals(null), false);
});

test('deriveBusinessStatus: client > active > prospect', () => {
  assert.equal(deriveBusinessStatus([{ stage: 'won' }]), 'client');
  assert.equal(deriveBusinessStatus([], true), 'client');                  // placed order, no deal recorded
  assert.equal(deriveBusinessStatus([{ stage: 'qualifying' }]), 'active');
  assert.equal(deriveBusinessStatus([{ stage: 'quoted' }, { stage: 'lost' }]), 'active');
  assert.equal(deriveBusinessStatus([{ stage: 'lost' }]), 'prospect');     // only a dead deal
  assert.equal(deriveBusinessStatus([]), 'prospect');
});

// ── Migration plan: additive, idempotent ─────────────────────────────────────
const ORDERS = [
  { _id: 'o1', companyKey: 'acme', companyName: 'Acme', status: 'delivered', totalValue: 500, orderNumber: '101', projectNumber: '22-1' },
  { _id: 'o2', companyKey: 'acme', companyName: 'Acme', status: 'quoted',    totalValue: 900, projectNumber: '22-2' },
  { _id: 'o3', companyKey: 'beta', companyName: 'Beta', status: 'cancelled', totalValue: 300, projectNumber: '23-1' },
];

test('planMigration: one deal per order, stage mapped from status', () => {
  const { toCreate } = planMigration({ orders: ORDERS, clients: [], existingDeals: [], batchId: 'b1' });
  assert.equal(toCreate.length, 3);
  const acmeWon = toCreate.find(d => d.sourceOrderId === 'o1');
  assert.equal(acmeWon.stage, 'won');
  assert.equal(acmeWon.value, 500);
  assert.equal(acmeWon.origin, 'migration');
  assert.equal(acmeWon.migrationBatch, 'b1');
  assert.equal(toCreate.find(d => d.sourceOrderId === 'o2').stage, 'quoted');
  assert.equal(toCreate.find(d => d.sourceOrderId === 'o3').stage, 'lost');
});

test('planMigration is IDEMPOTENT — orders that already have a deal are skipped', () => {
  const existingDeals = [
    { sourceOrderId: 'o1', companyKey: 'acme', stage: 'won' },
    { sourceOrderId: 'o2', companyKey: 'acme', stage: 'quoted' },
    { sourceOrderId: 'o3', companyKey: 'beta', stage: 'lost' },
  ];
  const { toCreate, skippedOrders } = planMigration({ orders: ORDERS, clients: [], existingDeals, batchId: 'b2' });
  assert.equal(toCreate.length, 0, 're-running creates nothing new');
  assert.equal(skippedOrders, 3);
});

test('planMigration: won/customer company with NO orders gets one synthetic won deal', () => {
  const clients = [
    { companyKey: 'gamma', companyName: 'Gamma', stage: 'customer', dealValue: 1200 }, // was a client, no orders on file
    { companyKey: 'delta', companyName: 'Delta', stage: 'won', dealValue: 0 },
    { companyKey: 'echo',  companyName: 'Echo',  stage: 'lead' },                        // just a lead → no deal
  ];
  const { toCreate } = planMigration({ orders: [], clients, existingDeals: [], batchId: 'b3' });
  assert.equal(toCreate.length, 2);
  assert.ok(toCreate.every(d => d.stage === 'won'));
  assert.deepEqual(toCreate.map(d => d.companyKey).sort(), ['delta', 'gamma']);
  assert.equal(toCreate.find(d => d.companyKey === 'gamma').value, 1200);
});

test('planMigration: a won company that already has an order is NOT double-counted', () => {
  const clients = [{ companyKey: 'acme', companyName: 'Acme', stage: 'customer' }];
  const { toCreate, skippedWonCompanies } = planMigration({ orders: ORDERS, clients, existingDeals: [], batchId: 'b4' });
  // 3 order-deals; the won company 'acme' already covered by its orders → no synthetic.
  assert.equal(toCreate.filter(d => d.companyKey === 'acme' && !d.sourceOrderId).length, 0);
  assert.equal(skippedWonCompanies, 1);
});

// ── sanitizeDeal ─────────────────────────────────────────────────────────────
test('sanitizeDeal: requires companyKey on create, validates stage, clamps value', () => {
  assert.equal(sanitizeDeal({}, { create: true }).error, 'companyKey is required');
  assert.ok(sanitizeDeal({ companyKey: 'acme', stage: 'nope' }).error);
  const { set } = sanitizeDeal({ companyKey: ' acme ', title: 'Reorder', value: -5, stage: 'quoting' === 'quoting' ? 'quoted' : 'quoted' });
  assert.equal(set.companyKey, 'acme');
  assert.equal(set.value, 0);            // negative clamped
  assert.equal(set.stage, 'quoted');
});
