// controllers/__tests__/crmBoard.test.js
//
// Pure-logic checks for the UNIFIED order-centric pipeline board (no DB). Runs on
// Node's built-in test runner — no extra dev deps:
//
//   node --test controllers/__tests__/crmBoard.test.js
//
// orderStatusToColumn / buildUnifiedBoard / summarizeBoard are exported from
// controllers/crm.js and take plain POJOs (lean Client + Order rows), so the whole
// feed shape is testable without Mongo.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  orderStatusToColumn,
  buildUnifiedBoard,
  summarizeBoard,
  isLiveOrderRow,
  orderCardKey,
  BOARD_COLUMNS,
  BOARD_CLOSED_COLUMNS,
  BOARD_PROBABILITY,
  promoteStage,
} = require('../crm');

// ── orderStatusToColumn — the status → board column mapper ───────────────────
test('orderStatusToColumn maps every Order status to its board column', () => {
  assert.equal(orderStatusToColumn('quoted'),        'quoting');
  assert.equal(orderStatusToColumn('approved'),      'approval');
  assert.equal(orderStatusToColumn('placed'),        'production');
  assert.equal(orderStatusToColumn('in_production'), 'production'); // both → one lean column
  assert.equal(orderStatusToColumn('shipped'),       'shipped');
  assert.equal(orderStatusToColumn('delivered'),     'delivered');
  assert.equal(orderStatusToColumn('cancelled'),     'cancelled');
});

test('orderStatusToColumn returns null for an unknown / missing status', () => {
  assert.equal(orderStatusToColumn('nonsense'), null);
  assert.equal(orderStatusToColumn(''),         null);
  assert.equal(orderStatusToColumn(undefined),  null);
  assert.equal(orderStatusToColumn(null),       null);
});

// ── isLiveOrderRow — what suppresses a company's lead card ───────────────────
test('isLiveOrderRow: non-archived non-cancelled orders are live; archived/cancelled are not', () => {
  assert.equal(isLiveOrderRow({ status: 'quoted' }),                 true);
  assert.equal(isLiveOrderRow({ status: 'delivered' }),              true); // delivered still got past lead
  assert.equal(isLiveOrderRow({ status: 'cancelled' }),              false);
  assert.equal(isLiveOrderRow({ status: 'quoted', archived: true }), false);
  assert.equal(isLiveOrderRow(null),                                 false);
});

// ── orderCardKey — stable, collision-proof per-order key ─────────────────────
test('orderCardKey prefers projectNumber, falls back to _id, always prefixed', () => {
  assert.equal(orderCardKey({ projectNumber: '138' }),          'order:138');
  assert.equal(orderCardKey({ projectNumber: 138 }),            'order:138');
  assert.equal(orderCardKey({ _id: 'abc123' }),                 'order:abc123');
  // projectNumber wins over _id when both present.
  assert.equal(orderCardKey({ projectNumber: '7', _id: 'x' }),  'order:7');
});

// ── buildUnifiedBoard scaffolding ─────────────────────────────────────────────
const mkClient = (over = {}) => ({
  companyKey: 'acme', companyName: 'Acme', clientName: '', dealValue: 0,
  stage: 'lead', nextFollowUp: null, address: '', area: '', interestType: '',
  tags: [], leadSource: '', ...over,
});
const mkOrder = (over = {}) => ({
  _id: `id-${Math.random().toString(36).slice(2)}`, companyKey: 'acme', companyName: 'Acme',
  clientName: '', projectNumber: '100', status: 'quoted', totalValue: 0, archived: false,
  orderDate: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...over,
});
// Pull the single group for a board column out of the assembled board.
const colOf = (board, col) => board.groups.find((g) => g.stage === col);

test('groups come back in board order: active columns then closed lane', () => {
  const board = buildUnifiedBoard({ clients: [], orders: [] });
  const order = board.groups.map((g) => g.stage);
  assert.deepEqual(order, [...BOARD_COLUMNS, ...BOARD_CLOSED_COLUMNS]);
  // Every column present even when empty, each with the back-compat `clients` key.
  for (const g of board.groups) {
    assert.ok(Array.isArray(g.clients), `${g.stage} must carry a clients[] array`);
    assert.equal(g.count, 0);
    assert.equal(g.totalValue, 0);
  }
});

test('a lead with NO live order shows ONE lead card in its stage column', () => {
  const board = buildUnifiedBoard({
    clients: [mkClient({ companyKey: 'lead-co', stage: 'lead', dealValue: 500 })],
    orders: [],
  });
  const lead = colOf(board, 'lead');
  assert.equal(lead.count, 1);
  assert.equal(lead.totalValue, 500);
  const card = lead.clients[0];
  assert.equal(card.cardKind, 'lead');
  assert.equal(card.cardKey, 'lead-co');     // lead card keyed by companyKey
  assert.equal(card.companyKey, 'lead-co');
  assert.equal(card.dealValue, 500);
});

test('contacted lead also seeds the contacted column', () => {
  const board = buildUnifiedBoard({
    clients: [mkClient({ companyKey: 'warm', stage: 'contacted', dealValue: 250 })],
    orders: [],
  });
  assert.equal(colOf(board, 'contacted').count, 1);
  assert.equal(colOf(board, 'lead').count, 0);
});

test('one order per status → one card in the matching column', () => {
  const orders = [
    mkOrder({ _id: 'o1', projectNumber: '1', status: 'quoted',        totalValue: 1000 }),
    mkOrder({ _id: 'o2', projectNumber: '2', status: 'approved',      totalValue: 2000 }),
    mkOrder({ _id: 'o3', projectNumber: '3', status: 'placed',        totalValue: 3000 }),
    mkOrder({ _id: 'o4', projectNumber: '4', status: 'in_production', totalValue: 4000 }),
    mkOrder({ _id: 'o5', projectNumber: '5', status: 'shipped',       totalValue: 5000 }),
    mkOrder({ _id: 'o6', projectNumber: '6', status: 'delivered',     totalValue: 6000 }),
  ];
  const board = buildUnifiedBoard({ clients: [], orders });
  assert.equal(colOf(board, 'quoting').count, 1);
  assert.equal(colOf(board, 'approval').count, 1);
  assert.equal(colOf(board, 'production').count, 2);   // placed + in_production
  assert.equal(colOf(board, 'shipped').count, 1);
  assert.equal(colOf(board, 'delivered').count, 1);
  // Production column totals both its orders.
  assert.equal(colOf(board, 'production').totalValue, 7000);
  // Order cards carry the right shape.
  const q = colOf(board, 'quoting').clients[0];
  assert.equal(q.cardKind, 'order');
  assert.equal(q.cardKey, 'order:1');
  assert.equal(q.projectNumber, '1');
  assert.equal(q.orderStatus, 'quoted');
  assert.equal(q._id, 'o1');
});

test('a company with MULTIPLE live orders → multiple cards (one client → many cards)', () => {
  const orders = [
    mkOrder({ _id: 'a', projectNumber: '10', status: 'quoted',    totalValue: 100 }),
    mkOrder({ _id: 'b', projectNumber: '11', status: 'approved',  totalValue: 200 }),
    mkOrder({ _id: 'c', projectNumber: '12', status: 'shipped',   totalValue: 300 }),
  ];
  const board = buildUnifiedBoard({ clients: [mkClient({ stage: 'customer' })], orders });
  // Three distinct order cards across three columns — all for the one company.
  assert.equal(colOf(board, 'quoting').count, 1);
  assert.equal(colOf(board, 'approval').count, 1);
  assert.equal(colOf(board, 'shipped').count, 1);
  // Every card key is unique (no React collision).
  const keys = board.groups.flatMap((g) => g.clients.map((c) => c.cardKey));
  assert.equal(new Set(keys).size, keys.length);
});

test('a lead WITH a live order is suppressed — it shows only as an order card (no dup)', () => {
  const board = buildUnifiedBoard({
    clients: [mkClient({ companyKey: 'acme', stage: 'lead', dealValue: 999 })],
    orders:  [mkOrder({ companyKey: 'acme', projectNumber: '50', status: 'quoted', totalValue: 1500 })],
  });
  // No leftover lead card…
  assert.equal(colOf(board, 'lead').count, 0);
  // …and exactly one order card in quoting.
  assert.equal(colOf(board, 'quoting').count, 1);
  assert.equal(colOf(board, 'quoting').clients[0].companyKey, 'acme');
});

test('a CANCELLED order does NOT suppress the lead card (company has no LIVE order)', () => {
  const board = buildUnifiedBoard({
    clients: [mkClient({ companyKey: 'acme', stage: 'lead', dealValue: 400 })],
    orders:  [mkOrder({ companyKey: 'acme', status: 'cancelled', totalValue: 0 })],
  });
  // The lead card survives (cancelled isn't a live order)…
  assert.equal(colOf(board, 'lead').count, 1);
  // …and the cancelled order lands in the closed lane.
  assert.equal(colOf(board, 'cancelled').count, 1);
});

test('cancelled orders go to the closed cancelled column', () => {
  const board = buildUnifiedBoard({
    clients: [],
    orders: [mkOrder({ projectNumber: '77', status: 'cancelled' })],
  });
  assert.equal(colOf(board, 'cancelled').count, 1);
  assert.equal(colOf(board, 'cancelled').clients[0].cardKind, 'order');
});

test('lost / dormant Client records seed the closed lane', () => {
  const board = buildUnifiedBoard({
    clients: [
      mkClient({ companyKey: 'gone',  stage: 'lost',    dealValue: 0 }),
      mkClient({ companyKey: 'quiet', stage: 'dormant', dealValue: 0 }),
    ],
    orders: [],
  });
  assert.equal(colOf(board, 'lost').count, 1);
  assert.equal(colOf(board, 'dormant').count, 1);
});

test('archived orders never appear on the board', () => {
  const board = buildUnifiedBoard({
    clients: [],
    orders: [mkOrder({ status: 'quoted', archived: true })],
  });
  assert.equal(colOf(board, 'quoting').count, 0);
});

test('won/customer Client stages (no order) contribute NO card; quoting/sampling fall back to the quoting column', () => {
  const board = buildUnifiedBoard({
    clients: [
      mkClient({ companyKey: 'q', stage: 'quoting',  dealValue: 100 }),
      mkClient({ companyKey: 's', stage: 'sampling', dealValue: 100 }),
      mkClient({ companyKey: 'w', stage: 'won',      dealValue: 100 }),
      mkClient({ companyKey: 'c', stage: 'customer', dealValue: 100 }),
    ],
    orders: [],
  });
  // won/customer with no order → no card.
  // quoting + sampling with no live order → fallback cards in the quoting column.
  assert.equal(colOf(board, 'quoting').count, 2);
  assert.equal(colOf(board, 'quoting').clients.every((k) => k.cardKind === 'lead'), true);
  // Nothing leaked into the other columns.
  const elsewhere = board.groups.filter((g) => g.stage !== 'quoting').reduce((n, g) => n + g.count, 0);
  assert.equal(elsewhere, 0);
});

test('a quoting Client falls back to a card but is SUPPRESSED once it has a live order (no dup)', () => {
  const board = buildUnifiedBoard({
    clients: [mkClient({ companyKey: 'acme', stage: 'quoting', dealValue: 500 })],
    orders:  [mkOrder({ companyKey: 'acme', projectNumber: '60', status: 'quoted', totalValue: 800 })],
  });
  // Exactly one card in quoting — the ORDER card, not a duplicate Client fallback.
  assert.equal(colOf(board, 'quoting').count, 1);
  assert.equal(colOf(board, 'quoting').clients[0].cardKind, 'order');
  assert.equal(colOf(board, 'quoting').clients[0].projectNumber, '60');
});

test('order dealValue falls back to the company dealValue when the order total is 0', () => {
  const board = buildUnifiedBoard({
    clients: [mkClient({ companyKey: 'acme', stage: 'customer', dealValue: 1234 })],
    orders:  [mkOrder({ companyKey: 'acme', projectNumber: '90', status: 'quoted', totalValue: 0 })],
    dealValueByKey: new Map([['acme', 1234]]),
  });
  assert.equal(colOf(board, 'quoting').clients[0].dealValue, 1234);
});

test('the delivered column is capped to the most-recent N orders', () => {
  const orders = Array.from({ length: 30 }, (_, i) => mkOrder({
    _id: `d${i}`, companyKey: `co${i}`, projectNumber: String(1000 + i), status: 'delivered',
    totalValue: 10, orderDate: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
  }));
  const board = buildUnifiedBoard({ clients: [], orders, deliveredCap: 25 });
  assert.equal(colOf(board, 'delivered').count, 25);   // capped
});

test('isCustomer is set on cards from the placed-orders set', () => {
  const board = buildUnifiedBoard({
    clients: [mkClient({ companyKey: 'cust', stage: 'lead', dealValue: 0 })],
    orders:  [mkOrder({ companyKey: 'cust2', status: 'quoted' })],
    withPlacedOrders: new Set(['cust', 'cust2']),
  });
  // The (live-order-less) lead card reflects the placed-order reality…
  // cust has no live order here, so it still shows as a lead, flagged customer.
  assert.equal(colOf(board, 'lead').clients[0].isCustomer, true);
  assert.equal(colOf(board, 'quoting').clients[0].isCustomer, true);
});

// ── summarizeBoard — header band over the unified set ────────────────────────
test('summarizeBoard: open value excludes delivered/won + closed lane; weighted spans all', () => {
  // One card per column, $1000 each, so the math is easy to verify.
  const groups = [
    { stage: 'lead',       clients: [{ dealValue: 1000 }] }, // open · w 0.10  → 100
    { stage: 'contacted',  clients: [{ dealValue: 1000 }] }, // open · w 0.25  → 250
    { stage: 'quoting',    clients: [{ dealValue: 1000 }] }, // open · w 0.50  → 500
    { stage: 'approval',   clients: [{ dealValue: 1000 }] }, // open · w 0.80  → 800
    { stage: 'production', clients: [{ dealValue: 1000 }] }, // open · w 0.90  → 900
    { stage: 'shipped',    clients: [{ dealValue: 1000 }] }, // open · w 0.95  → 950
    { stage: 'delivered',  clients: [{ dealValue: 1000 }] }, // CLOSED-won · w 1 → 1000
    { stage: 'lost',       clients: [{ dealValue: 1000 }] }, // dead · w 0    → 0
    { stage: 'dormant',    clients: [{ dealValue: 1000 }] }, // dead · w 0    → 0
    { stage: 'cancelled',  clients: [{ dealValue: 1000 }] }, // dead · w 0    → 0
  ];
  const out = summarizeBoard(groups);
  // Open = lead+contacted+quoting+approval+production+shipped (6 × 1000).
  assert.equal(out.totalOpenValue, 6000);
  // Weighted = 100+250+500+800+900+950+1000 = 4500.
  assert.equal(out.weightedValue, 4500);
});

test('summarizeBoard accepts a flat card list too', () => {
  const out = summarizeBoard([
    { stage: 'quoting', dealValue: 2000 },   // open · w 0.5 → 1000
    { stage: 'delivered', dealValue: 5000 }, // not open · w 1 → 5000
  ]);
  assert.equal(out.totalOpenValue, 2000);
  assert.equal(out.weightedValue, 6000);
});

test('summarizeBoard zeroes on empty / missing input', () => {
  assert.deepEqual(summarizeBoard([]),        { totalOpenValue: 0, weightedValue: 0 });
  assert.deepEqual(summarizeBoard(undefined), { totalOpenValue: 0, weightedValue: 0 });
});

test('the assembled board summary matches summarizeBoard over its groups', () => {
  // The lead company is DISTINCT from the order companies so its lead card isn't
  // suppressed (the orders below belong to acme; the lead is a separate prospect).
  const orders = [
    mkOrder({ _id: 'o1', companyKey: 'acme', projectNumber: '1', status: 'quoted',    totalValue: 1000 }),
    mkOrder({ _id: 'o2', companyKey: 'acme', projectNumber: '2', status: 'delivered', totalValue: 5000 }),
    mkOrder({ _id: 'o3', companyKey: 'acme', projectNumber: '3', status: 'cancelled', totalValue: 9999 }),
  ];
  const board = buildUnifiedBoard({ clients: [mkClient({ companyKey: 'fresh-lead', stage: 'lead', dealValue: 400 })], orders });
  // Open = lead 400 + quoting 1000 = 1400 (delivered/cancelled excluded).
  assert.equal(board.summary.totalOpenValue, 1400);
  // Weighted = 400×0.1 + 1000×0.5 + 5000×1 + 9999×0 = 40 + 500 + 5000 = 5540.
  assert.equal(board.summary.weightedValue, 5540);
});

// ── ensureCompanyForQuoting's stage decision (promoteStage → 'quoting') ───────
// The lead→quote handoff ensures a Client at 'quoting' WITHOUT regressing an
// owner-advanced or closed stage. ensureCompanyForQuoting hits the DB, but its
// decision is promoteStage(stage, 'quoting') — pin that contract here.
test('promoteStage(_, "quoting") advances early stages but never regresses or resurrects', () => {
  // A brand-new / early record advances to quoting.
  assert.equal(promoteStage('lead',      'quoting'), 'quoting');
  assert.equal(promoteStage('contacted', 'quoting'), 'quoting');
  assert.equal(promoteStage('quoting',   'quoting'), 'quoting');
  // An owner-advanced stage past quoting is NOT pulled back.
  assert.equal(promoteStage('sampling',  'quoting'), 'sampling');
  assert.equal(promoteStage('won',       'quoting'), 'won');
  assert.equal(promoteStage('customer',  'quoting'), 'customer');
  // A deliberately-closed/parked stage is never resurrected by the handoff.
  assert.equal(promoteStage('lost',      'quoting'), 'lost');
  assert.equal(promoteStage('dormant',   'quoting'), 'dormant');
});

test('BOARD_PROBABILITY exposes the per-column close-rates', () => {
  assert.equal(BOARD_PROBABILITY.lead,       0.1);
  assert.equal(BOARD_PROBABILITY.contacted,  0.25);
  assert.equal(BOARD_PROBABILITY.quoting,    0.5);
  assert.equal(BOARD_PROBABILITY.approval,   0.8);
  assert.equal(BOARD_PROBABILITY.production, 0.9);
  assert.equal(BOARD_PROBABILITY.shipped,    0.95);
  assert.equal(BOARD_PROBABILITY.delivered,  1);
  assert.equal(BOARD_PROBABILITY.cancelled,  0);
});
