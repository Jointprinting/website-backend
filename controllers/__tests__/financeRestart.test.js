// controllers/__tests__/financeRestart.test.js
//
// Pure-logic checks for the "restart finances from my budgets" flow + the seed
// categorization. No DB — every function takes plain POJOs. Run with:
//
//   node --test controllers/__tests__/financeRestart.test.js
//
// These PIN the safety + correctness contract the owner relies on:
//   • raw cash net reconciles to his pre-parse ($22,413.41) and the P&L refinements
//     (Owner Contribution/Draw out of profit, Refund contra) behave;
//   • preserve-vs-replace keeps his latest manual entries and never double-counts a
//     manual row the budget already has;
//   • per-order grouping reunites a sale with its COGS by budget hint WITHOUT
//     trusting the hint as cross-system identity;
//   • categorization + party dedup put each row in the right bucket/name.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  summarizeRows, groupOrders, buildPreservePlan, buildRestartPlan,
  dedupSig, coarseKey, samePartyOrDesc, seedRowToDoc, normalizeOrderNumber, incomeRevenue,
} = require('../../services/financeRestart');
const {
  categorize, categorizeIncome, categorizeExpense, canonicalParty,
  incomeParty, expenseParty, parseOrderHint, stripDecorations,
  applyVoids, buildProcessingFeeRows,
} = require('../../services/financeSeed');

// ── row factories (seed-row shape: positive amount, explicit type) ───────────
const inc = (amount, over = {}) => ({ date: '2025-06-05', type: 'income', category: 'Client Sales', amount, party: 'Acme', orderNumber: '5', description: 'Sales - Acme (Order #5)', ...over });
const exp = (amount, over = {}) => ({ date: '2025-06-06', type: 'expense', category: 'Blank COGS', amount, party: 'S&S Activewear', orderNumber: '5', description: 'Sales - S&S Activewear (Order #5)', ...over });

// ── seed integrity: the committed seed reconciles to the pre-parse ───────────
test('committed seed: corrected totals (Mad Martian voided + QB fees) reconcile', () => {
  const seedPath = path.join(__dirname, '..', '..', 'data', 'financeLedgerSeed.json');
  if (!fs.existsSync(seedPath)) { console.warn('seed not built; skipping'); return; }
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const s = summarizeRows(seed.rows);
  // After the owner corrections the seed is 330 parsed − 3 voided (Mad Martian #122:
  // 1 income + 2 cost) + 39 QB processing-fee rows = 366.
  assert.equal(s.rows, 366, 'seed must have 366 rows after void + fee rows');
  // Net profit = prior $15,863.72 − $948.37 (Mad Martian profit) − $1,481.93 (fees).
  assert.equal(s.net, 13433.42, 'corrected net profit ≈ $13.4k');
  // Raw cash net falls by the same corrections (phantom profit + the real fees).
  assert.equal(s.rawCashNet, 19983.11, 'corrected raw cash net');
  // Owner equity is OUT of the P&L; profit is the smaller refined number.
  assert.equal(s.ownerContribution, 8000);
  assert.ok(s.net < s.rawCashNet, 'P&L profit is below cash net (equity excluded)');
  // Mad Martian #122 is fully gone — no income AND no cost row survives.
  const mm = seed.rows.filter((r) => normalizeOrderNumber(r.orderNumber) === '122'
    || /mad martian/i.test(`${r.party || ''} ${r.description || ''}`));
  assert.equal(mm.length, 0, 'no Mad Martian / #122 row may remain (voided both sides)');
  // The QB processing fees total exactly $1,481.93 and are a COGS-class expense.
  const fees = seed.rows.filter((r) => r.category === 'Processing Fee');
  const feeSum = fees.reduce((a, r) => a + r.amount, 0);
  assert.equal(Math.round(feeSum * 100) / 100, 1481.93, 'processing fees sum to $1,481.93');
  assert.equal(fees.length, 39, 'one fee row per QB deposit');
  assert.ok(fees.every((r) => r.type === 'expense'), 'every fee is an expense');
});

test('committed seed: each matched QB fee lands on the order it paid', () => {
  const seedPath = path.join(__dirname, '..', '..', 'data', 'financeLedgerSeed.json');
  if (!fs.existsSync(seedPath)) { console.warn('seed not built; skipping'); return; }
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const fees = seed.rows.filter((r) => r.category === 'Processing Fee');
  // The Happy Leaf $45.96 CC fee must sit on order #141 (the budget hint), tagged to
  // Happy Leaf, on the sale's date — so it reduces THAT order's profit.
  const hl = fees.find((r) => Math.abs(r.amount - 45.96) < 0.005);
  assert.ok(hl, 'Happy Leaf processing fee exists');
  assert.equal(normalizeOrderNumber(hl.orderNumber), '141');
  assert.match(hl.party, /happy leaf/i);
  // The refund deposit (−$220.91, fee $7.73) books ONLY its fee, on Shaggy's order —
  // it is NOT turned into a second refund.
  const ref = fees.find((r) => Math.abs(r.amount - 7.73) < 0.005);
  assert.ok(ref, 'the refund deposit still books its $7.73 fee');
  assert.match(ref.party, /shaggy/i);
  // 37 fees attach to an order; 2 deposits with no budget income row stay unattributed
  // (no order #) but still count — so the total stays $1,481.93.
  const matched = fees.filter((r) => normalizeOrderNumber(r.orderNumber)).length;
  assert.equal(matched, 37, '37 fees tie to an order');
  assert.equal(fees.length - matched, 2, '2 fees are unattributed (no budget income twin)');
});

test('committed seed: EVERY row is dated + validates against the Transaction model', () => {
  // Regression for the critical bug: 280/330 budget rows are undated in the source;
  // the builder must anchor them to their sheet-month so date (required) is set and
  // the year filter places them. An undated doc → required-date validation failure →
  // apply would gut the ledger. This pins that all rows insert cleanly.
  const seedPath = path.join(__dirname, '..', '..', 'data', 'financeLedgerSeed.json');
  if (!fs.existsSync(seedPath)) { console.warn('seed not built; skipping'); return; }
  const Transaction = require('../../models/Transaction');
  const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  let failures = 0;
  const byYear = {};
  for (const r of seed.rows) {
    const doc = seedRowToDoc(r, 'b');
    assert.ok(doc.date instanceof Date && !isNaN(doc.date.getTime()), `row has a valid date: ${r.description}`);
    const err = new Transaction(doc).validateSync();
    if (err) failures += 1;
    byYear[doc.year] = (byYear[doc.year] || 0) + 1;
  }
  assert.equal(failures, 0, 'no seed row may fail model validation');
  // The year filter must have real rows in EACH year (2026 must show its orders).
  assert.ok((byYear[2024] || 0) > 0 && (byYear[2025] || 0) > 0 && (byYear[2026] || 0) > 0,
    'every year has rows so the year filter shows each year');
});

// ── summarizeRows: P&L refinements ───────────────────────────────────────────
test('summarizeRows: Owner Contribution is equity IN (not revenue/profit)', () => {
  const s = summarizeRows([
    inc(1000),
    { date: '2024-04-19', type: 'income', category: 'Owner Contribution', amount: 8000, party: "Owner's Deposit", orderNumber: '', description: "Owner's Deposit" },
  ]);
  assert.equal(s.income, 1000, 'owner contribution must NOT inflate income');
  assert.equal(s.ownerContribution, 8000);
  assert.equal(s.rawCashNet, 9000, 'but it IS cash in the bank');
  assert.equal(s.net, 1000);
});

test('summarizeRows: Owner Draw is equity OUT (not an expense/profit hit)', () => {
  const s = summarizeRows([
    inc(1000),
    { date: '2026-06-07', type: 'expense', category: 'Owner Draw', amount: 300, party: '', orderNumber: '', description: "Owner's Withdrawal" },
  ]);
  assert.equal(s.expense, 0, 'owner draw must NOT count as a business expense');
  assert.equal(s.ownerDraw, 300);
  assert.equal(s.net, 1000, 'profit is unaffected by a draw');
  assert.equal(s.rawCashNet, 700, 'but cash went down by the draw');
});

test('summarizeRows: Refund is contra-revenue (nets income DOWN)', () => {
  const s = summarizeRows([
    inc(1000),
    { date: '2026-02-05', type: 'income', category: 'Refund', amount: 75, party: 'Allianz', orderNumber: '', description: 'Allianz - Refund' },
  ]);
  assert.equal(s.income, 925, 'a refund reduces revenue');
  assert.equal(s.refund, 75);
  assert.equal(s.rawCashNet, 1075, 'a refund-IN still increases cash (money came back)');
});

// ── per-order grouping: reunite sale + COGS by budget hint ───────────────────
test('groupOrders: a sale and its COGS sharing a budget hint form ONE order', () => {
  const rows = [
    inc(1383.93, { party: 'Plantabis', orderNumber: '139', description: 'Sales - Plantabis (Order #139)' }),
    exp(60, { party: 'Heritage Screen Printing', category: 'Printer COGS', orderNumber: '139', description: 'Sales - Heritage (Order #139)' }),
    exp(107.47, { party: 'UPS', category: 'Shipping', orderNumber: '139', description: 'Shipping - UPS (Order #139)' }),
  ];
  const g = groupOrders(rows);
  assert.equal(g.orders.length, 1, 'one order for the #139 group');
  const o = g.orders[0];
  assert.equal(o.client, 'Plantabis');
  assert.deepEqual(o.budgetHints, ['139']);
  assert.equal(o.revenue, 1383.93);
  assert.equal(o.cost, 167.47);
  assert.equal(o.profit, 1216.46);
  assert.equal(o.ambiguous, false);
});

test('groupOrders: a vendor-named cost routes to the client who sold under its hint', () => {
  // "Sales - Heritage (#139)" is a COST; its client is Plantabis (who has the #139
  // SALE), NOT "Heritage" — the routing reads the unique sale client for the hint.
  const rows = [
    inc(1000, { party: 'Plantabis', orderNumber: '139', description: 'Sales - Plantabis (Order #139)' }),
    exp(60, { party: 'Heritage Screen Printing', category: 'Printer COGS', orderNumber: '139', description: 'Sales - Heritage (Order #139)' }),
  ];
  const g = groupOrders(rows);
  assert.equal(g.orders.length, 1);
  assert.equal(g.orders[0].client, 'Plantabis');
  assert.equal(g.orders[0].cost, 60);
});

test('groupOrders: two different clients keep their own orders (hint is not identity)', () => {
  const rows = [
    inc(500, { party: 'Plantabis', orderNumber: '139', description: 'Sales - Plantabis (#139)' }),
    inc(800, { party: 'VT3D', orderNumber: '124', description: 'Sales - VT3D (#124)' }),
  ];
  const g = groupOrders(rows);
  assert.equal(g.orders.length, 2);
  const byClient = Object.fromEntries(g.orders.map((o) => [o.client, o]));
  assert.equal(byClient.Plantabis.revenue, 500);
  assert.equal(byClient.VT3D.revenue, 800);
});

test('groupOrders: overhead COGS with no order hint goes to unassigned (not a fake order)', () => {
  const rows = [
    inc(1000, { party: 'Acme', orderNumber: '5', description: 'Sales - Acme (#5)' }),
    { date: '2025-06-01', type: 'expense', category: 'Software', amount: 20, party: 'OpenAI', orderNumber: '', description: 'OpenAI' },
    { date: '2025-06-02', type: 'expense', category: 'Blank COGS', amount: 99, party: 'Mystery', orderNumber: '', description: 'Mystery blank' },
  ];
  const g = groupOrders(rows);
  // Only the Acme #5 order; the unhinted COGS row is unassigned (Software isn't COGS).
  assert.equal(g.orders.length, 1);
  assert.equal(g.unassignedCount, 2);
  assert.equal(g.unassignedCost, 99, 'only the COGS-category unassigned cost is summed');
});

// ── preserve vs replace ──────────────────────────────────────────────────────
test('buildPreservePlan: prior budget rows are replaced; new manual rows are kept', () => {
  const seedRows = [inc(1000, { date: '2025-06-05', orderNumber: '5' })];
  const live = [
    { _id: 'b1', source: 'budget', date: new Date('2025-01-01'), amount: 50, orderNumber: '1' },     // prior restart → replace
    { _id: 'm1', source: 'manual', date: new Date('2026-06-20'), amount: 15, orderNumber: '' },        // new → keep
  ];
  const p = buildPreservePlan(seedRows, live);
  assert.equal(p.toDeleteCount, 1);
  assert.equal(p.preservedCount, 1);
  assert.equal(p.droppedDuplicateCount, 0);
  assert.equal(p.toPreserve[0]._id, 'm1');
});

test('buildPreservePlan: a manual row that DUPLICATES a budget row is dropped (no double-count)', () => {
  // Same date + amount + direction + SAME party as the seed row → SAME entry — even
  // though the manual order # differs (the correction: identity is NOT the order #).
  const seedRows = [inc(1000, { date: '2025-06-05', orderNumber: '5', party: 'Acme' })];
  const live = [
    { _id: 'm1', source: 'manual', date: new Date('2025-06-05T12:00:00Z'), amount: 1000, orderNumber: '9999', party: 'Acme', type: 'income', category: 'Client Sales' }, // dup (different #)
  ];
  const p = buildPreservePlan(seedRows, live);
  assert.equal(p.droppedDuplicateCount, 1, 'the manual duplicate is dropped despite a different order #');
  assert.equal(p.preservedCount, 0);
});

test('buildPreservePlan: THE FIX — manual "#1052 Happy Leaf" collapses with budget "Happy Leaf D" (one order)', () => {
  // The owner-reported "two lines for Happy Leaf": his manual entry carries invoice
  // #1052; the budget row carries his manual #141 and the fuller name. Same date +
  // amount + income → ONE order (no double), matched on the client, not the number.
  const seedRows = [inc(1537.16, { date: '2026-06-04', party: 'Happy Leaf Dispensary', orderNumber: '141', description: 'Sales - Happy Leaf Dispensary (Order #141)' })];
  const live = [
    { _id: 'hl', source: 'manual', date: new Date('2026-06-04T12:00:00Z'), amount: 1537.16, orderNumber: '1052', party: 'Happy Leaf', type: 'income', category: 'Client Sales', description: '#1052 Happy Leaf' },
  ];
  const p = buildPreservePlan(seedRows, live);
  assert.equal(p.droppedDuplicateCount, 1, 'the manual Happy Leaf row collapses into the budget one');
  assert.equal(p.preservedCount, 0, 'it is NOT kept as a second Happy Leaf line');
});

test('buildPreservePlan: manual "Anthropic $5" dedups against budget "Anthropic API $5"', () => {
  const seedRows = [{ date: '2026-06-01', type: 'expense', category: 'Software', amount: 5, party: 'Anthropic API', orderNumber: '', description: 'Anthropic API' }];
  const live = [
    { _id: 'an', source: 'manual', date: new Date('2026-06-01T12:00:00Z'), amount: 5, orderNumber: '', party: 'Anthropic', type: 'expense', category: 'Software', description: 'Anthropic $5' },
  ];
  const p = buildPreservePlan(seedRows, live);
  assert.equal(p.droppedDuplicateCount, 1, 'the manual Anthropic $5 collapses into the budget Anthropic API $5');
});

test('buildPreservePlan: a genuinely-new manual entry NOT in the budget is PRESERVED', () => {
  // A brand-new $100 manual charge with no same-day/same-cent budget twin survives.
  const seedRows = [inc(1537.16, { date: '2026-06-04', party: 'Happy Leaf Dispensary', orderNumber: '141' })];
  const live = [
    { _id: 'new1', source: 'manual', date: new Date('2026-06-10T12:00:00Z'), amount: 100, orderNumber: '', party: 'New Vendor', type: 'expense', category: 'Other', description: 'One-off charge' },
    // Same amount as a budget row but a DIFFERENT party + day → not a dup (preserved).
    { _id: 'new2', source: 'manual', date: new Date('2026-07-01T12:00:00Z'), amount: 1537.16, orderNumber: '', party: 'Different Co', type: 'income', category: 'Client Sales', description: 'Unrelated sale' },
  ];
  const p = buildPreservePlan(seedRows, live);
  assert.equal(p.preservedCount, 2, 'both genuinely-new manual rows are kept');
  assert.equal(p.droppedDuplicateCount, 0);
});

test('samePartyOrDesc: client variants match; unrelated same-amount rows do not', () => {
  assert.ok(samePartyOrDesc({ party: 'Happy Leaf' }, { party: 'Happy Leaf Dispensary' }));
  assert.ok(samePartyOrDesc({ party: 'Anthropic', description: 'Anthropic $5' }, { party: 'Anthropic API' }));
  // A $70 Amtrak trip vs a $70 supplier cost share NO meaningful party/desc token.
  assert.ok(!samePartyOrDesc({ party: 'Amtrak', description: 'Amtrak NJ->VT' }, { party: 'Mystery Blanks', description: 'blanks' }));
  // Two anonymous rows (no party, boilerplate desc) never match on stop-words alone.
  assert.ok(!samePartyOrDesc({ description: 'Sales - Order' }, { description: 'Sales - Order' }));
});

test('coarseKey: same day+amount+type collide regardless of zero-padding/Date vs string; cent differs', () => {
  const a = coarseKey({ date: '2025-06-05', amount: 1000, type: 'income' });
  const b = coarseKey({ date: new Date('2025-06-05T12:00:00Z'), amount: 1000, type: 'income' });
  assert.equal(a, b);
  const c = coarseKey({ date: '2025-06-05', amount: 1000.01, type: 'income' });
  assert.notEqual(a, c, 'a cent difference is a different bucket');
  // Direction matters: a $1000 sale and a $1000 cost on the same day are different.
  assert.notEqual(coarseKey({ date: '2025-06-05', amount: 1000, type: 'income' }), coarseKey({ date: '2025-06-05', amount: 1000, type: 'expense' }));
});

test('dedupSig / buildPreservePlan: a row with no usable date is never dedupable (always preserved)', () => {
  const a = dedupSig({ date: '', amount: 70, party: 'X', type: 'expense' });
  const b = dedupSig({ date: '', amount: 70, party: 'X', type: 'expense' });
  assert.notEqual(a, b, 'two undated rows get unique signatures (never collapse together)');
  // And through the plan: an undated manual row is preserved even against an undated seed row.
  const p = buildPreservePlan(
    [{ date: '', amount: 70, party: 'X', type: 'expense', category: 'Other' }],
    [{ _id: 'u', source: 'manual', date: '', amount: 70, party: 'X', type: 'expense', category: 'Other' }],
  );
  assert.equal(p.preservedCount, 1);
  assert.equal(p.droppedDuplicateCount, 0);
});

// ── seedRowToDoc ─────────────────────────────────────────────────────────────
test('seedRowToDoc: stamps source budget + batch, normalizes order #, UTC-noon date', () => {
  const d = seedRowToDoc({ date: '2025-06-05', type: 'income', category: 'Client Sales', amount: 1000, party: 'Acme', orderNumber: '0005', description: 'x', recordedInQB: true }, 'batch-1');
  assert.equal(d.source, 'budget');
  assert.equal(d.restartBatchId, 'batch-1');
  assert.equal(d.orderNumber, '5');
  assert.equal(d.qbSynced, true);
  assert.equal(d.amount, 1000);
  assert.equal(d.year, 2025);
  assert.equal(d.date.toISOString(), '2025-06-05T12:00:00.000Z');
});

// ── categorization ───────────────────────────────────────────────────────────
test('categorizeIncome: Owner Deposit → Owner Contribution; refunds → Refund; else Client Sales', () => {
  assert.equal(categorizeIncome("Owner's Deposit"), 'Owner Contribution');
  assert.equal(categorizeIncome('Sales - JFS (Order #000001)'), 'Client Sales');
  assert.equal(categorizeIncome("Refund - Shaggy's Baggy (Order #000022 - BIC)"), 'Refund');
  assert.equal(categorizeIncome('S&S Sample Return (Order #000043)'), 'Refund');
  assert.equal(categorizeIncome('Allianz Global Assistance - Refund'), 'Refund');
});

test('categorizeExpense: COGS vs operating buckets land correctly (side decides direction)', () => {
  // "Sales - <vendor>" on the EXPENSE side is a COST, not revenue.
  assert.equal(categorizeExpense('Sales - Heritage Screen Printing (Order #000091)'), 'Printer COGS');
  assert.equal(categorizeExpense('Sales - S&SActivewear (Order #000083)'), 'Blank COGS');
  assert.equal(categorizeExpense('Sales - Alphabroder (Order #000001)'), 'Blank COGS');
  assert.equal(categorizeExpense('Sales - Shipping (Order #000001)'), 'Shipping');
  assert.equal(categorizeExpense('Shipping - UPS (Order #000091)'), 'Shipping');
  assert.equal(categorizeExpense('Sales - ArcBest (Order #000030)'), 'Shipping');
  assert.equal(categorizeExpense('Art - Denis Gathonjia (Order #0000120)'), 'Art');
  assert.equal(categorizeExpense('Wise Payments (Denis)'), 'Art');
  assert.equal(categorizeExpense('Commission - Alvin (91,83)'), 'Commission');
  assert.equal(categorizeExpense('Render'), 'Software');
  assert.equal(categorizeExpense('Anthropic Monthly Subscription'), 'Software');
  assert.equal(categorizeExpense('Meta Ads - Days 7/50'), 'Marketing');
  assert.equal(categorizeExpense("Owner's Withdrawal"), 'Owner Draw');
  assert.equal(categorizeExpense('Owners Withdrawal'), 'Owner Draw');
  assert.equal(categorizeExpense('NJ Division of Revenue (Sales Tax)'), 'Sales Tax');
  assert.equal(categorizeExpense("Ryan Jotkoff - Accounting Fees (Tax Season '25)"), 'Accounting');
  assert.equal(categorizeExpense('Gas - Costco (Field Work)'), 'Travel/Field');
  assert.equal(categorizeExpense('Amtrak (NJ->VT)'), 'Travel/Field');
  assert.equal(categorizeExpense('Walmart-Map'), 'Other');
});

// ── party canonicalization (spelling-variant dedup) ──────────────────────────
test('canonicalParty: owner spelling variants collapse to ONE name', () => {
  assert.equal(canonicalParty('Heritage'), 'Heritage Screen Printing');
  assert.equal(canonicalParty('Hertage Screen Printing'), 'Heritage Screen Printing');
  assert.equal(canonicalParty('Heritage Screen Printing'), 'Heritage Screen Printing');
  assert.equal(canonicalParty('S&SActivewear'), 'S&S Activewear');
  assert.equal(canonicalParty('S&S Activewear Samples'), 'S&S Activewear');
  assert.equal(canonicalParty('CannabisPromotions'), 'Cannabis Promotions');
  assert.equal(canonicalParty('Cannabis Promotions'), 'Cannabis Promotions');
  assert.equal(canonicalParty('The CannaBoss Lady'), 'The Cannaboss Lady');
  assert.equal(canonicalParty('The Cannaboss Lady'), 'The Cannaboss Lady');
  assert.equal(canonicalParty('OS NYC'), 'OS NYC');
  assert.equal(canonicalParty('Apollo East'), 'Apollo East');
  // a name with no variant rule passes through unchanged
  assert.equal(canonicalParty('Plantabis'), 'Plantabis');
});

test('incomeParty / expenseParty: extract the bare counterparty, strip decorations', () => {
  assert.equal(incomeParty('Sales - The Cannaboss Lady (Order #000083)'), 'The Cannaboss Lady');
  assert.equal(incomeParty("Refund - Shaggy's Baggy (Order #000022 - BIC)"), "Shaggy's Baggy");
  assert.equal(expenseParty('Sales - S&SActivewear (Order #000083)'), 'S&SActivewear');
  assert.equal(expenseParty('Shipping - UPS (Order #000083) [tees]'), 'UPS');
  assert.equal(expenseParty('Sales - UPS (Order #000022) Reship (To Nate)'), 'UPS');
  assert.equal(expenseParty('Commission - Alvin (91,83)'), 'Alvin');
});

test('parseOrderHint: pulls a normalized budget hint (or empty)', () => {
  assert.equal(parseOrderHint('Sales - JFS (Order #000001)'), '1');
  assert.equal(parseOrderHint('Sales - Cannabis Promotions (Order #139)'), '139');
  assert.equal(parseOrderHint('Render'), '');
  assert.equal(parseOrderHint('Sales - Happy Leaf Dispensary (Order #141)'), '141');
});

// ── owner corrections: void + QB processing fees (pure builders) ─────────────
test('applyVoids: a voided order removes BOTH its income and cost rows', () => {
  const rows = [
    { type: 'income', amount: 3557.27, orderNumber: '122', party: 'Mad Martian Farms', category: 'Client Sales' },
    { type: 'expense', amount: 2239, orderNumber: '0000122', party: 'Cannabis Promotions', category: 'Blank COGS' },
    { type: 'expense', amount: 369.9, orderNumber: '122', party: 'Full Designs', category: 'Printer COGS' },
    { type: 'income', amount: 1000, orderNumber: '123', party: 'Other', category: 'Client Sales' }, // survives
  ];
  const kept = applyVoids(rows, [{ orderNumber: '122' }]);
  assert.equal(kept.length, 1, 'all three #122 rows (incl. leading-zero variant) are gone');
  assert.equal(kept[0].orderNumber, '123');
});

test('buildProcessingFeeRows: matches a deposit to its sale by amount+date → linked COGS', () => {
  const rows = [
    { date: '2026-06-04', type: 'income', category: 'Client Sales', amount: 1537.16, party: 'Happy Leaf Dispensary', orderNumber: '141' },
    { date: '2026-06-01', type: 'income', category: 'Client Sales', amount: 413.65, party: 'Coastline Dispensary', orderNumber: '140' },
  ];
  const deposits = [
    { date: '2026-06-24', gross: 1537.16, fee: 45.96, method: 'CC' },
    { date: '2026-06-17', gross: 413.65, fee: 4.14, method: 'ACH' },
  ];
  const fees = buildProcessingFeeRows(rows, deposits);
  assert.equal(fees.length, 2);
  const hl = fees.find((f) => Math.abs(f.amount - 45.96) < 0.005);
  assert.equal(hl.type, 'expense');
  assert.equal(hl.category, 'Processing Fee');
  assert.equal(hl.orderNumber, '141', 'fee rides the order it paid (by amount)');
  assert.equal(hl.party, 'Happy Leaf Dispensary');
  assert.equal(hl.date, '2026-06-04', 'fee dated to the sale, not the deposit');
  assert.match(hl.description, /processing fee/i);
  assert.equal(hl.recordedInQB, true);
});

test('buildProcessingFeeRows: two same-amount sales each grab their OWN nearest deposit', () => {
  const rows = [
    { date: '2025-09-01', type: 'income', category: 'Client Sales', amount: 5600, party: 'Stadium Gardens', orderNumber: '107' },
    { date: '2026-03-01', type: 'income', category: 'Client Sales', amount: 5600, party: 'Yuma Way', orderNumber: '129' },
  ];
  const deposits = [
    { date: '2025-09-23', gross: 5600, fee: 56.0, method: 'ACH' },   // nearest to Stadium
    { date: '2026-03-08', gross: 5600, fee: 167.44, method: 'CC' },  // nearest to Yuma
  ];
  const fees = buildProcessingFeeRows(rows, deposits);
  const byOrder = Object.fromEntries(fees.map((f) => [f.orderNumber, f.amount]));
  assert.equal(byOrder['107'], 56.0, 'Stadium got its $56 ACH fee');
  assert.equal(byOrder['129'], 167.44, 'Yuma got its $167.44 CC fee');
});

test('buildProcessingFeeRows: the refund deposit books only its fee (no second refund) on the refund order', () => {
  const rows = [
    { date: '2025-05-01', type: 'income', category: 'Refund', amount: 220.91, party: "Shaggy's Baggy", orderNumber: '22', description: "Refund - Shaggy's Baggy" },
  ];
  const deposits = [{ date: '2025-05-27', gross: -220.91, fee: 7.73, method: 'ACH' }];
  const fees = buildProcessingFeeRows(rows, deposits);
  assert.equal(fees.length, 1, 'only a fee row — NOT another refund/income row');
  assert.equal(fees[0].type, 'expense');
  assert.equal(fees[0].amount, 7.73);
  assert.equal(fees[0].orderNumber, '22', 'fee lands on the refunded order');
});

test('buildProcessingFeeRows: a deposit with no matching income still books its fee (unattributed)', () => {
  const rows = [{ date: '2025-01-01', type: 'income', category: 'Client Sales', amount: 999, party: 'X', orderNumber: '1' }];
  const deposits = [{ date: '2025-03-27', gross: 1464.42, fee: 43.79, method: 'CC' }]; // no income twin
  const fees = buildProcessingFeeRows(rows, deposits);
  assert.equal(fees.length, 1, 'the fee is still booked');
  assert.equal(fees[0].amount, 43.79);
  assert.equal(fees[0].orderNumber, '', 'unattributed (no order #) but still a real cost');
  assert.equal(fees._unmatched, 1);
});

// ── buildRestartPlan: end-to-end shape + Happy Leaf discrepancy ──────────────
test('buildRestartPlan: surfaces the curated Happy Leaf #141→project#138 mismatch', () => {
  const seed = { rows: [
    inc(1537.16, { party: 'Happy Leaf Dispensary', orderNumber: '141', description: 'Sales - Happy Leaf Dispensary (Order #141)' }),
  ] };
  const plan = buildRestartPlan(seed, { transactions: [] }, {
    knownDiscrepancies: [{ budgetHint: '141', kind: 'budget-number-mismatch', projectNumber: '138', invoiceNumber: '1052', detail: 'Happy Leaf is project #138.' }],
  });
  const hl = plan.discrepancies.find((d) => d.kind === 'budget-number-mismatch');
  assert.ok(hl, 'the Happy Leaf mismatch must be surfaced');
  assert.equal(hl.projectNumber, '138');
  assert.equal(hl.invoiceNumber, '1052');
  assert.equal(hl.budgetHint, '141');
  // and the order itself groups as ONE Happy Leaf order, not split.
  const order = plan.byOrder.find((o) => o.client === 'Happy Leaf Dispensary');
  assert.equal(order.revenue, 1537.16);
  assert.deepEqual(order.budgetHints, ['141']);
});

test('buildRestartPlan: a stale known-discrepancy (hint absent from seed) is dropped', () => {
  const seed = { rows: [inc(100, { party: 'Acme', orderNumber: '5' })] };
  const plan = buildRestartPlan(seed, { transactions: [] }, {
    knownDiscrepancies: [{ budgetHint: '999', kind: 'budget-number-mismatch', detail: 'gone' }],
  });
  assert.equal(plan.discrepancies.filter((d) => d.kind === 'budget-number-mismatch').length, 0);
});
