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
const { isClientFromDeals, deriveBusinessStatus, planMigration, groupOrdersByJob } = require('../../services/dealService');
const { sanitizeDeal } = require('../deals');

// ── Order status → deal stage ────────────────────────────────────────────────
// Owner's rule: a deal is WON only at delivery — a placed/in-production/shipped
// order is still an OPEN deal (quote_sent), so the auto-win fires exactly once,
// at the delivered tick.
test('dealStageFromOrderStatus maps order reality to the pipeline', () => {
  assert.equal(Deal.dealStageFromOrderStatus('quoted'), 'quoting');
  assert.equal(Deal.dealStageFromOrderStatus('approved'), 'quote_sent');
  assert.equal(Deal.dealStageFromOrderStatus('placed'), 'quote_sent');
  assert.equal(Deal.dealStageFromOrderStatus('in_production'), 'quote_sent');
  assert.equal(Deal.dealStageFromOrderStatus('shipped'), 'quote_sent');
  assert.equal(Deal.dealStageFromOrderStatus('delivered'), 'won');
  assert.equal(Deal.dealStageFromOrderStatus('cancelled'), 'lost');
  assert.equal(Deal.dealStageFromOrderStatus(''), 'quoting');      // unknown → open
});

// The schema default must always be a live stage — a stale default (e.g. the
// retired 'qualifying') would make every stage-less create fail validation.
test('Deal schema default stage is a live open stage', () => {
  const d = new Deal({ companyKey: 'x' });
  assert.ok(Deal.DEAL_STAGES.includes(d.stage));
  assert.ok(Deal.OPEN_STAGES.includes(d.stage));
});

// ── Derive-client (≥1 won deal = client) ─────────────────────────────────────
test('isClientFromDeals: true only with a live won deal', () => {
  assert.equal(isClientFromDeals([{ stage: 'won' }]), true);
  assert.equal(isClientFromDeals([{ stage: 'quoting' }, { stage: 'lost' }]), false);
  assert.equal(isClientFromDeals([{ stage: 'won', archived: true }]), false); // archived doesn't count
  assert.equal(isClientFromDeals([]), false);
  assert.equal(isClientFromDeals(null), false);
});

test('deriveBusinessStatus: client > active > prospect', () => {
  assert.equal(deriveBusinessStatus([{ stage: 'won' }]), 'client');
  assert.equal(deriveBusinessStatus([], true), 'client');                  // placed order, no deal recorded
  assert.equal(deriveBusinessStatus([{ stage: 'details_needed' }]), 'active');
  assert.equal(deriveBusinessStatus([{ stage: 'quoting' }, { stage: 'lost' }]), 'active');
  assert.equal(deriveBusinessStatus([{ stage: 'quote_sent' }]), 'active');
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
  assert.equal(toCreate.find(d => d.sourceOrderId === 'o2').stage, 'quoting');
  assert.equal(toCreate.find(d => d.sourceOrderId === 'o3').stage, 'lost');
});

// ── De-dup: multiple Order docs for ONE job → ONE deal ───────────────────────
// The reported bug: a job that exists as two Order docs (a project/quote doc and a
// placed/invoice doc) produced two deal cards — one titled #<projectNumber>, one
// #<orderNumber>. The migration must collapse them into a single deal.
test('planMigration collapses duplicate Order docs for one job into a single deal', () => {
  const orders = [
    // the full doc: project 30 + invoice 1021, placed
    { _id: 'full', companyKey: 'bract', companyName: 'Bract House', status: 'placed', totalValue: 8321, orderNumber: '1021', projectNumber: '30' },
    // a duplicate doc for the same job (shares the invoice number), still at quote
    { _id: 'dup',  companyKey: 'bract', companyName: 'Bract House', status: 'quoted', totalValue: 8321, orderNumber: '1021' },
  ];
  const { toCreate } = planMigration({ orders, clients: [], existingDeals: [], batchId: 'b5' });
  assert.equal(toCreate.length, 1, 'one job → one deal, not two');
  const d = toCreate[0];
  assert.equal(d.stage, 'quote_sent', 'the placed doc wins as survivor (open until delivered)');
  assert.equal(d.sourceOrderId, 'full');
  assert.equal(d.orderNumber, '1021');
  assert.equal(d.projectNumber, '30', 'both numbers merged onto the one deal');
});

test('groupOrdersByJob: unions on a shared number, keeps distinct jobs apart', () => {
  const orders = [
    { _id: 'a', companyKey: 'x', projectNumber: '000061', orderNumber: '1036' }, // leading zeros
    { _id: 'b', companyKey: 'x', projectNumber: '61' },                          // same job as a
    { _id: 'c', companyKey: 'x', projectNumber: '62' },                          // different job
    { _id: 'd', companyKey: 'y', projectNumber: '61' },                          // different COMPANY, not merged
  ];
  const groups = groupOrdersByJob(orders).map((g) => g.map((o) => o._id).sort());
  // a+b collapse (normalized 61 == 000061); c and d stand alone.
  assert.equal(groups.length, 3);
  assert.ok(groups.some((g) => g.join() === 'a,b'));
  assert.ok(groups.some((g) => g.join() === 'c'));
  assert.ok(groups.some((g) => g.join() === 'd'));
});

test('planMigration is IDEMPOTENT — orders that already have a deal are skipped', () => {
  const existingDeals = [
    { sourceOrderId: 'o1', companyKey: 'acme', stage: 'won' },
    { sourceOrderId: 'o2', companyKey: 'acme', stage: 'quoting' },
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
  assert.ok(sanitizeDeal({ companyKey: 'acme', stage: 'quoted' }).error, 'retired stage rejected post-cutover');
  const { set } = sanitizeDeal({ companyKey: ' acme ', title: 'Reorder', value: -5, stage: 'quoting' });
  assert.equal(set.companyKey, 'acme');
  assert.equal(set.value, 0);            // negative clamped
  assert.equal(set.stage, 'quoting');
});
