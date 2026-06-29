// controllers/__tests__/financeDedupe.test.js
//
// Pure-logic checks for the "merge duplicate transactions" flow — the cross-source
// duplicate detector + the merge-field union. No DB — every function takes plain
// POJOs. Run with:
//
//   node --test controllers/__tests__/financeDedupe.test.js
//
// These PIN the safety + correctness contract the owner relies on:
//   • a budget-restart row and the owner's manual/receipt copy of the SAME payment
//     (dates drifted ~2 weeks) ARE detected as one duplicate pair and merged into ONE
//     row that keeps EVERY link (receipt + project/order link + invoice #);
//   • two genuinely-distinct SAME-source recurring charges (two monthly $20 in
//     different months) are NEVER merged — the cross-source requirement guards it;
//   • the merge loses nothing, counts the amount once, and the genuinely-new manual
//     entry with no budget twin is left untouched.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findDuplicatePairs, buildDedupePlan, mergeTransactions, mergedPreview,
  samePartyOrDesc, isBudgetRow, isManualRow, richerParty, combineText, daysApart,
} = require('../../services/financeDedupe');

// ── row factories (live Transaction shape: positive amount, explicit type) ───
let _id = 0;
const oid = () => `id${++_id}`;
const row = (over = {}) => ({
  _id: oid(), date: '2026-06-04', type: 'expense', category: 'Software',
  party: '', description: '', amount: 0, isCredit: false,
  orderNumber: '', invoiceNumber: '', receiptUrl: '', source: 'manual', ...over,
});
// A budget-restart row (the copy the restart loaded from the budget tracker).
const budget = (over = {}) => row({ source: 'budget', ...over });
// A manual hand entry (the owner's own in-app row).
const manual = (over = {}) => row({ source: 'manual', ...over });
// A receipt-booked row (created from an uploaded receipt; carries the receipt file).
const receipt = (over = {}) => row({ source: 'receipt', ...over });

// ── the owner's three known cases, modeled on the live post-restart ledger ───

test('Happy Leaf: manual receipt+invoice row ↔ budget project-link row → ONE merged row keeping ALL links', () => {
  // The manual entry: invoice #1052, has the uploaded RECEIPT, NO project/order link,
  // dated ~2 weeks BEFORE the budget copy (the drift the restart missed).
  const manualHL = receipt({
    date: '2026-05-21', type: 'income', category: 'Customer Sales', amount: 1537.16,
    party: 'Happy Leaf', description: 'Invoice #1052', invoiceNumber: '1052',
    receiptUrl: 'https://r2/receipts/hl-1052.pdf', orderNumber: '',
  });
  // The budget row: has the project/order link (#138), no receipt, no invoice #.
  const budgetHL = budget({
    date: '2026-06-04', type: 'income', category: 'Customer Sales', amount: 1537.16,
    party: 'Happy Leaf Dispensary', description: 'Sales - Happy Leaf Dispensary (Order #138)',
    orderNumber: '138', receiptUrl: '', invoiceNumber: '',
  });

  const pairs = findDuplicatePairs([manualHL, budgetHL]);
  assert.equal(pairs.length, 1, 'exactly one Happy Leaf duplicate pair');
  const p = pairs[0];
  // The survivor is the BUDGET row; the manual row is folded in + removed.
  assert.equal(String(p.budget._id), String(budgetHL._id));
  assert.equal(String(p.manual._id), String(manualHL._id));

  const m = p.merged;
  assert.equal(m.amount, 1537.16, 'amount counts ONCE');
  assert.equal(m.receiptUrl, 'https://r2/receipts/hl-1052.pdf', 'keeps the uploaded receipt');
  assert.equal(m.orderNumber, '138', 'keeps the project/order link');
  assert.equal(m.invoiceNumber, '1052', 'keeps invoice #1052');
  assert.equal(m.party, 'Happy Leaf Dispensary', 'keeps the richer party name');
  assert.ok(m.keepsReceipt && m.keepsOrderLink && m.keepsInvoice, 'all three links preserved');
  // The combined description carries both the invoice note and the budget sale line.
  assert.match(m.description, /1052/);
  assert.match(m.description, /Order #138/);
});

test('Anthropic $5: manual receipt row ↔ budget row → ONE merged row keeping the receipt', () => {
  const manualAnthropic = receipt({
    date: '2026-06-14', amount: 5, party: 'Anthropic', description: 'Anthropic API charge',
    receiptUrl: 'https://r2/receipts/anthropic-5.pdf',
  });
  const budgetAnthropic = budget({
    date: '2026-06-01', amount: 5, party: 'Anthropic API', description: 'Anthropic API',
  });
  const pairs = findDuplicatePairs([manualAnthropic, budgetAnthropic]);
  assert.equal(pairs.length, 1, 'one Anthropic $5 pair');
  assert.equal(pairs[0].merged.receiptUrl, 'https://r2/receipts/anthropic-5.pdf', 'keeps the receipt');
  assert.equal(pairs[0].merged.amount, 5);
});

test('the genuinely-new $100 Anthropic manual entry (no budget twin) is NOT flagged', () => {
  // A manual $100 with no matching budget row of the same amount → never a pair.
  const manual100 = manual({ date: '2026-06-10', amount: 100, party: 'Anthropic', description: 'Anthropic Monthly Subscription' });
  // (Budget Anthropic rows exist at OTHER amounts — $5, $20 — none at $100.)
  const budget5 = budget({ date: '2026-06-01', amount: 5, party: 'Anthropic API', description: 'Anthropic API' });
  const budget20 = budget({ date: '2026-05-01', amount: 20, party: 'Anthropic Monthly Subscription', description: 'Anthropic Monthly Subscription' });
  const pairs = findDuplicatePairs([manual100, budget5, budget20]);
  assert.equal(pairs.filter((p) => p.budget.amount === 100 || p.manual.amount === 100).length, 0, '$100 manual is untouched');
});

test("the owner's three cases together: exactly TWO merges, the $100 survives", () => {
  const ledger = [
    receipt({ _id: 'hl-m', date: '2026-05-21', type: 'income', category: 'Customer Sales', amount: 1537.16, party: 'Happy Leaf', invoiceNumber: '1052', receiptUrl: 'r2/hl.pdf' }),
    budget({ _id: 'hl-b', date: '2026-06-04', type: 'income', category: 'Customer Sales', amount: 1537.16, party: 'Happy Leaf Dispensary', orderNumber: '138', description: 'Sales - Happy Leaf Dispensary (Order #138)' }),
    receipt({ _id: 'an5-m', date: '2026-06-14', amount: 5, party: 'Anthropic', receiptUrl: 'r2/an5.pdf' }),
    budget({ _id: 'an5-b', date: '2026-06-01', amount: 5, party: 'Anthropic API', description: 'Anthropic API' }),
    manual({ _id: 'an100', date: '2026-06-10', amount: 100, party: 'Anthropic', description: 'Anthropic Monthly Subscription' }),
  ];
  const plan = buildDedupePlan(ledger);
  assert.equal(plan.pairCount, 2, 'exactly two duplicate pairs (Happy Leaf + Anthropic $5)');
  assert.equal(plan.summary.receiptsPreserved, 2, 'both receipts preserved');
  assert.equal(plan.summary.orderLinksPreserved, 1, 'Happy Leaf project link preserved');
  assert.equal(plan.summary.invoicesPreserved, 1, 'invoice #1052 preserved');
  // The $100 manual is in neither pair.
  const touched = new Set();
  for (const p of plan.pairs) { touched.add(String(p.budget._id)); touched.add(String(p.manual._id)); }
  assert.ok(!touched.has('an100'), 'the $100 manual entry is untouched');
});

// ── ADVERSARIAL: never false-merge two genuinely-distinct charges ────────────

test('ADVERSARIAL: two same-amount monthly charges in DIFFERENT months are NOT merged (same source)', () => {
  // Two separate $20 OpenAI charges, both MANUAL, different months. Same amount + same
  // party — but BOTH are manual (same source), so they can never be a cross-source
  // pair. This is the core false-merge guard.
  const may = manual({ date: '2026-05-03', amount: 20, party: 'OpenAI', description: 'OpenAI ChatGPT Plus' });
  const june = manual({ date: '2026-06-03', amount: 20, party: 'OpenAI', description: 'OpenAI ChatGPT Plus' });
  const pairs = findDuplicatePairs([may, june]);
  assert.equal(pairs.length, 0, 'two same-source recurring charges must NOT merge');
});

test('ADVERSARIAL: two BUDGET rows of the same amount/party are NOT merged', () => {
  // Even within the budget, two like rows are not a cross-source pair.
  const a = budget({ date: '2026-04-01', amount: 20, party: 'Anthropic Monthly Subscription', description: 'Anthropic Monthly Subscription' });
  const b = budget({ date: '2026-05-01', amount: 20, party: 'Anthropic Monthly Subscription', description: 'Anthropic Monthly Subscription' });
  assert.equal(findDuplicatePairs([a, b]).length, 0, 'two budget rows never merge');
});

test('ADVERSARIAL: cross-source ADJACENT-MONTH recurring charges are NOT merged (window is below a monthly cycle)', () => {
  // The subtle one: a budget $20 OpenAI for MAY and a manual $20 OpenAI for JUNE are two
  // genuinely-distinct monthly charges that happen to be cross-source. They are ~31 days
  // apart — beyond the 30-day window — so they must NOT collapse into one. (The ~2-week
  // manual-vs-budget drift the owner actually has is well within the window.)
  const may = budget({ date: '2026-05-05', amount: 20, party: 'OpenAI', description: 'OpenAI ChatGPT Plus' });
  const june = manual({ date: '2026-06-05', amount: 20, party: 'OpenAI', description: 'OpenAI ChatGPT Plus' });
  assert.ok(daysApart(may, june) > 30, 'precondition: adjacent months are > 30 days apart');
  assert.equal(findDuplicatePairs([may, june]).length, 0, 'adjacent-month recurring → not a duplicate');
  // But the SAME vendor within the window (drifted ~2 weeks, the real case) IS a duplicate.
  const drifted = manual({ date: '2026-05-19', amount: 20, party: 'OpenAI', description: 'OpenAI ChatGPT Plus' });
  assert.equal(findDuplicatePairs([may, drifted]).length, 1, '~14 days apart → merged');
});

test('ADVERSARIAL: two DISTINCT vendors sharing one ordinary description word are NOT merged', () => {
  // The party gate must be PARTY-only and conservative: "web hosting" vs "web design"
  // share the token "web", but the parties (CloudAlpha vs BetaStudio) are different
  // businesses. Same amount + cross-source + same week — but NOT the same counterparty.
  const a = budget({ date: '2026-06-01', type: 'expense', amount: 88, party: 'CloudAlpha', description: 'web hosting annual' });
  const b = receipt({ date: '2026-06-08', type: 'expense', amount: 88, party: 'BetaStudio', description: 'web design work', receiptUrl: 'r2/beta.pdf', invoiceNumber: 'B-77' });
  assert.ok(!samePartyOrDesc(a, b), 'precondition: parties are not the same counterparty');
  assert.equal(findDuplicatePairs([a, b]).length, 0, 'shared descriptor word → not a duplicate (no $88 vanishes)');
});

test('ADVERSARIAL: a bare brand vs a DIFFERENT business that starts with it ("Apex" vs "Apex Apparel") is NOT merged', () => {
  // Mirrors the vendorMatch guard: "Apex" must not swallow "Apex Apparel" (a distinct
  // business whose extra word is distinguishing, not boilerplate). But "Anthropic" SHOULD
  // match "Anthropic API" (the extra word IS boilerplate) — the owner's real case.
  assert.ok(!samePartyOrDesc({ party: 'Apex' }, { party: 'Apex Apparel' }), 'Apex ≠ Apex Apparel');
  assert.ok(!samePartyOrDesc({ party: 'Heritage' }, { party: 'Heritage Sportswear' }), 'Heritage ≠ Heritage Sportswear');
  assert.ok(samePartyOrDesc({ party: 'Anthropic' }, { party: 'Anthropic API' }), 'Anthropic ≈ Anthropic API (boilerplate tail)');
  assert.ok(samePartyOrDesc({ party: 'Acme' }, { party: 'Acme Inc' }), 'Acme ≈ Acme Inc (entity-type tail)');
  // End-to-end: an Apex/Apex-Apparel pair is not flagged.
  const apex = budget({ date: '2026-06-04', type: 'expense', amount: 300, party: 'Apex', description: 'screens' });
  const apexApparel = receipt({ date: '2026-06-08', type: 'expense', amount: 300, party: 'Apex Apparel', description: 'blanks', receiptUrl: 'r2/apex.pdf' });
  assert.equal(findDuplicatePairs([apex, apexApparel]).length, 0, 'Apex vs Apex Apparel → not a duplicate');
});

test('CONFLICTING links are preserved: a competing receipt/order/invoice is noted, never silently lost', () => {
  // If BOTH rows carry a DIFFERENT non-empty link, the survivor keeps one as the live
  // field and the loser is preserved in the description note AND the mergedFrom audit.
  const b = budget({ _id: 'b', date: '2026-06-04', type: 'income', category: 'Customer Sales', amount: 500, party: 'Acme', orderNumber: '111', invoiceNumber: 'INV-1', receiptUrl: 'r2/budget.pdf', description: 'budget sale' });
  const m = receipt({ _id: 'm', date: '2026-05-25', type: 'income', category: 'Customer Sales', amount: 500, party: 'Acme', orderNumber: '222', invoiceNumber: 'INV-2', receiptUrl: 'r2/manual.pdf', description: 'manual sale' });
  const { set } = mergeTransactions(b, m);
  // Survivor keeps its own primary values…
  assert.equal(set.orderNumber, '111');
  assert.equal(set.invoiceNumber, 'INV-1');
  assert.equal(set.receiptUrl, 'r2/budget.pdf');
  // …and the competing values are NOT lost — noted in the description and the audit.
  assert.match(set.description, /also order #222/);
  assert.match(set.description, /also invoice #INV-2/);
  assert.match(set.description, /also receipt r2\/manual\.pdf/);
  assert.equal(set.mergedFrom[0].receiptUrl, 'r2/manual.pdf', 'folded receipt retained in audit');
  assert.equal(set.mergedFrom[0].orderNumber, '222', 'folded order retained in audit');
  assert.equal(set.mergedFrom[0].invoiceNumber, 'INV-2', 'folded invoice retained in audit');
});

test('ADVERSARIAL: same amount + same day but DIFFERENT direction is NOT merged', () => {
  // A $70 expense and a $70 income on the same day, cross-source — different `type`,
  // so different direction bucket → never compared.
  const exp = budget({ date: '2026-06-04', type: 'expense', amount: 70, party: 'Amtrak', description: 'Amtrak trip' });
  const inc = manual({ date: '2026-06-04', type: 'income', amount: 70, party: 'Amtrak', description: 'Amtrak refund?' });
  assert.equal(findDuplicatePairs([exp, inc]).length, 0, 'opposite direction → not a duplicate');
  // Same for an expense vs an expense-CREDIT (a supplier refund) at the same amount.
  const debit = budget({ date: '2026-06-04', type: 'expense', amount: 70, party: 'S&S', isCredit: false });
  const credit = manual({ date: '2026-06-06', type: 'expense', amount: 70, party: 'S&S', isCredit: true });
  assert.equal(findDuplicatePairs([debit, credit]).length, 0, 'debit vs credit → not a duplicate');
});

test('ADVERSARIAL: same amount + same day + cross-source but UNRELATED party is NOT merged', () => {
  // A $70 Amtrak budget cost and a $70 supplier cost on the same day — same amount,
  // same direction, cross-source, but no shared party/description token.
  const amtrak = budget({ date: '2026-06-04', type: 'expense', amount: 70, party: 'Amtrak', description: 'Train to NYC' });
  const supplier = manual({ date: '2026-06-04', type: 'expense', amount: 70, party: 'Sanmar', description: 'Blank tees restock' });
  assert.ok(!samePartyOrDesc(amtrak, supplier), 'precondition: parties do not match');
  assert.equal(findDuplicatePairs([amtrak, supplier]).length, 0, 'unrelated party → not a duplicate');
});

test('ADVERSARIAL: one budget row + THREE manual rows of the same amount → exactly ONE pair (closest), other two untouched', () => {
  // Only one of the three manual rows is the budget twin (the closest in date + same
  // party); the other two are genuinely-distinct charges and must survive.
  const b = budget({ _id: 'b', date: '2026-06-15', amount: 20, party: 'OpenAI', description: 'OpenAI Plus' });
  const m1 = manual({ _id: 'm1', date: '2026-06-12', amount: 20, party: 'OpenAI', description: 'OpenAI Plus' });   // closest → the twin
  const m2 = manual({ _id: 'm2', date: '2026-04-12', amount: 20, party: 'OpenAI', description: 'OpenAI Plus' });   // far month → distinct
  const m3 = manual({ _id: 'm3', date: '2026-02-12', amount: 20, party: 'OpenAI', description: 'OpenAI Plus' });   // far month → distinct
  const pairs = findDuplicatePairs([b, m1, m2, m3]);
  assert.equal(pairs.length, 1, 'exactly one pair');
  assert.equal(String(pairs[0].manual._id), 'm1', 'the CLOSEST manual row is the twin');
});

test('ADVERSARIAL: an import/order:auto/fee:auto row is never a merge side', () => {
  // The cross-source rule is budget↔(manual|receipt). Automated rows are excluded.
  const b = budget({ date: '2026-06-04', amount: 45.96, type: 'expense', category: 'Processing Fee', party: 'Happy Leaf', description: 'fee' });
  const feeAuto = row({ source: 'fee:auto', date: '2026-06-04', amount: 45.96, type: 'expense', category: 'Processing Fee', party: 'Happy Leaf', description: 'fee' });
  const imported = row({ source: 'import', date: '2026-06-05', amount: 45.96, type: 'expense', category: 'Processing Fee', party: 'Happy Leaf', description: 'fee' });
  assert.equal(findDuplicatePairs([b, feeAuto]).length, 0, 'fee:auto is not a merge side');
  assert.equal(findDuplicatePairs([b, imported]).length, 0, 'import is not a merge side');
});

// ── merge-field union: EVERY link is preserved, nothing clobbered ────────────

test('mergeTransactions: unions every link without losing any (receipt from manual, order+invoice from either)', () => {
  const b = budget({ _id: 'b', date: '2026-06-04', type: 'income', category: 'Customer Sales', amount: 1537.16, party: 'Happy Leaf Dispensary', orderNumber: '138', description: 'Sales - Happy Leaf (Order #138)', qbSynced: true });
  const m = receipt({ _id: 'm', date: '2026-05-21', type: 'income', category: 'Customer Sales', amount: 1537.16, party: 'Happy Leaf', invoiceNumber: '1052', receiptUrl: 'r2/hl.pdf', description: 'Invoice #1052' });
  const { survivorId, removeId, set } = mergeTransactions(b, m);
  assert.equal(survivorId, 'b', 'survivor is the budget row');
  assert.equal(removeId, 'm', 'the manual row is removed');
  assert.equal(set.receiptUrl, 'r2/hl.pdf', 'receipt pulled from the manual row');
  assert.equal(set.orderNumber, '138', 'order link kept from the budget row');
  assert.equal(set.invoiceNumber, '1052', 'invoice kept from the manual row');
  assert.equal(set.qbSynced, true, 'qbSynced OR-ed');
  assert.equal(set.source, 'merge', 'survivor marked as a merge result');
  assert.equal(set.mergedFrom.length, 1, 'one folded row recorded in the audit');
  assert.equal(set.mergedFrom[0].receiptUrl, 'r2/hl.pdf', 'audit keeps the folded receipt');
});

test('mergeTransactions: a receipt on the SURVIVOR is never overwritten by a blank', () => {
  // If the budget row somehow already had a receipt and the manual had none, keep it.
  const b = budget({ _id: 'b', amount: 50, party: 'Vendor', receiptUrl: 'r2/keep.pdf' });
  const m = manual({ _id: 'm', amount: 50, party: 'Vendor', receiptUrl: '' });
  const { set } = mergeTransactions(b, m);
  assert.equal(set.receiptUrl, 'r2/keep.pdf', 'survivor receipt is not clobbered by a blank');
});

test('richerParty / combineText helpers behave', () => {
  assert.equal(richerParty({ party: 'Happy Leaf' }, { party: 'Happy Leaf Dispensary' }), 'Happy Leaf Dispensary');
  assert.equal(richerParty({ party: '' }, { party: 'Anthropic' }), 'Anthropic');
  assert.equal(combineText('Anthropic API', 'Anthropic API'), 'Anthropic API', 'identical collapses');
  assert.equal(combineText('Invoice #1052', ''), 'Invoice #1052');
  assert.match(combineText('Invoice #1052', 'Sales - Happy Leaf (Order #138)'), /1052.*138/);
});

test('isBudgetRow / isManualRow classify sources correctly', () => {
  assert.ok(isBudgetRow({ source: 'budget' }));
  assert.ok(!isBudgetRow({ source: 'manual' }));
  assert.ok(isManualRow({ source: 'manual' }));
  assert.ok(isManualRow({ source: 'receipt' }));
  assert.ok(isManualRow({ source: '' }), 'legacy blank source is manual-class');
  assert.ok(isManualRow({}), 'missing source is manual-class');
  assert.ok(!isManualRow({ source: 'import' }));
  assert.ok(!isManualRow({ source: 'fee:auto' }));
  assert.ok(!isManualRow({ source: 'merge' }), 'a prior merge survivor is not re-merged');
});

test('buildDedupePlan: groups are preview-shaped (ids as strings, both rows + merged result)', () => {
  const b = budget({ _id: 'b', date: '2026-06-04', amount: 5, party: 'Anthropic API', description: 'Anthropic API' });
  const m = receipt({ _id: 'm', date: '2026-06-14', amount: 5, party: 'Anthropic', receiptUrl: 'r2/a.pdf' });
  const plan = buildDedupePlan([b, m]);
  assert.equal(plan.groups.length, 1);
  const g = plan.groups[0];
  assert.equal(g.budget.id, 'b');
  assert.equal(g.manual.id, 'm');
  assert.equal(g.merged.receiptUrl, 'r2/a.pdf');
  assert.ok(typeof g.daysApart === 'number');
});

test('pair keys are content-derived (the two row ids) and STABLE across input order', () => {
  // The same data in two different orders must yield the SAME pair keys, so a key the
  // UI captured in the preview still targets the right pair on apply (a DB find() has
  // no guaranteed order).
  const hlM = receipt({ _id: 'hl-m', date: '2026-05-21', type: 'income', category: 'Customer Sales', amount: 1537.16, party: 'Happy Leaf', invoiceNumber: '1052', receiptUrl: 'r2/hl.pdf' });
  const hlB = budget({ _id: 'hl-b', date: '2026-06-04', type: 'income', category: 'Customer Sales', amount: 1537.16, party: 'Happy Leaf Dispensary', orderNumber: '138' });
  const an5M = receipt({ _id: 'an5-m', date: '2026-06-14', amount: 5, party: 'Anthropic', receiptUrl: 'r2/an5.pdf' });
  const an5B = budget({ _id: 'an5-b', date: '2026-06-01', amount: 5, party: 'Anthropic API', description: 'Anthropic API' });

  const keysA = findDuplicatePairs([hlM, hlB, an5M, an5B]).map((p) => p.key).sort();
  const keysB = findDuplicatePairs([an5B, an5M, hlB, hlM]).map((p) => p.key).sort();
  assert.deepEqual(keysA, keysB, 'pair keys identical regardless of input order');
  // And each key is exactly budgetId|manualId.
  assert.ok(keysA.includes('hl-b|hl-m'), 'Happy Leaf key is budgetId|manualId');
  assert.ok(keysA.includes('an5-b|an5-m'), 'Anthropic key is budgetId|manualId');
});

// ── REVERSIBILITY: merge → revert restores the exact pre-merge ledger ─────────
// Replays the controller's apply/revert ALGORITHM (snapshot both rows + the survivor's
// prior fields → update survivor → delete redundant; revert rolls the survivor back +
// re-inserts the removed row) against a tiny in-memory store, so the round-trip
// contract is pinned without a live Mongo. Mirrors the makeFakeModel pattern the
// backup tests use.
test('REVERSIBLE: merge then revert restores both original rows byte-for-byte', () => {
  // The survivor fields the controller snapshots (kept in sync with the controller).
  const FIELDS = ['orderNumber', 'invoiceNumber', 'receiptUrl', 'party', 'description', 'category',
    'isCredit', 'qbSynced', 'paymentMethod', 'feeRateOverride', 'source', 'mergedFrom', 'dedupeBatchId'];

  // In-memory ledger keyed by _id.
  const store = new Map();
  const seed = (t) => store.set(String(t._id), { ...t });
  const b = budget({ _id: 'b', date: '2026-06-04', type: 'income', category: 'Customer Sales', amount: 1537.16, party: 'Happy Leaf Dispensary', orderNumber: '138', description: 'Sales - Happy Leaf (Order #138)', mergedFrom: [], dedupeBatchId: '' });
  const m = receipt({ _id: 'm', date: '2026-05-21', type: 'income', category: 'Customer Sales', amount: 1537.16, party: 'Happy Leaf', invoiceNumber: '1052', receiptUrl: 'r2/hl.pdf', description: 'Invoice #1052' });
  seed(b); seed(m);
  const before = JSON.stringify([...store.values()].sort((x, y) => String(x._id).localeCompare(String(y._id))));

  // ── APPLY (replays controller.dedupeApply) ──
  const plan = buildDedupePlan([...store.values()]);
  assert.equal(plan.pairCount, 1);
  const batchId = 'findedupe-test';
  // snapshot
  const survivorBefore = plan.pairs.map((p) => {
    const s = store.get(String(p.budget._id));
    const snap = {}; for (const f of FIELDS) snap[f] = s[f];
    return { id: String(p.budget._id), before: snap };
  });
  const originalRows = [...plan.pairs.flatMap((p) => [p.budget._id, p.manual._id])]
    .map((id) => ({ ...store.get(String(id)) }));
  // update survivor + delete redundant
  for (const p of plan.pairs) {
    const { set } = mergeTransactions(p.budget, p.manual);
    store.set(String(p.budget._id), { ...store.get(String(p.budget._id)), ...set, dedupeBatchId: batchId });
    store.delete(String(p.manual._id));
  }
  // After apply: ONE row, amount once, carries every link.
  assert.equal(store.size, 1, 'redundant row removed — amount counts once');
  const survivor = store.get('b');
  assert.equal(survivor.receiptUrl, 'r2/hl.pdf');
  assert.equal(survivor.orderNumber, '138');
  assert.equal(survivor.invoiceNumber, '1052');
  assert.equal(survivor.source, 'merge');
  assert.equal(survivor.dedupeBatchId, batchId);

  // ── REVERT (replays controller.dedupeRevert) ──
  const survivorIds = new Set(survivorBefore.map((s) => String(s.id)));
  for (const s of survivorBefore) {
    const set = { ...s.before };
    set.dedupeBatchId = s.before.dedupeBatchId || '';
    store.set(String(s.id), { ...store.get(String(s.id)), ...set });
  }
  for (const r of originalRows.filter((r) => !survivorIds.has(String(r._id)))) {
    store.set(String(r._id), { ...r });
  }

  const after = JSON.stringify([...store.values()].sort((x, y) => String(x._id).localeCompare(String(y._id))));
  assert.equal(after, before, 'after revert the ledger is byte-for-byte the pre-merge state');
});

test('REVERSIBLE: a survivor with a PRE-EXISTING mergedFrom + feeRateOverride is captured and restored', () => {
  // Guards the survivorBefore fidelity: if the budget survivor already carried an
  // earlier merge audit and a negotiated fee rate, the snapshot must capture them and
  // the revert must put them back EXACTLY (not blank them).
  const FIELDS = ['orderNumber', 'invoiceNumber', 'receiptUrl', 'party', 'description', 'category',
    'isCredit', 'qbSynced', 'paymentMethod', 'feeRateOverride', 'source', 'mergedFrom', 'dedupeBatchId'];
  const priorAudit = [{ _id: 'old', party: 'Earlier fold', amount: 1537.16 }];
  const b = budget({ _id: 'b', date: '2026-06-04', type: 'income', category: 'Customer Sales', amount: 1537.16, party: 'Happy Leaf Dispensary', orderNumber: '138', feeRateOverride: 0.025, mergedFrom: priorAudit, paymentMethod: 'cc' });
  const m = receipt({ _id: 'm', date: '2026-05-21', type: 'income', category: 'Customer Sales', amount: 1537.16, party: 'Happy Leaf', invoiceNumber: '1052', receiptUrl: 'r2/hl.pdf' });

  // snapshot survivorBefore (the controller's exact capture)
  const before = {}; for (const f of FIELDS) before[f] = b[f];
  assert.deepEqual(before.mergedFrom, priorAudit, 'pre-existing audit captured');
  assert.equal(before.feeRateOverride, 0.025, 'negotiated fee rate captured');

  // merge appends to the audit (does not lose the prior fold) and keeps the fee rate
  const { set } = mergeTransactions(b, m);
  assert.equal(set.mergedFrom.length, 2, 'audit appended, prior fold preserved');
  assert.equal(set.mergedFrom[0].party, 'Earlier fold', 'prior fold still first');
  assert.equal(set.feeRateOverride, 0.025, 'survivor fee rate kept through the merge');

  // revert restores the survivor to before
  const restored = { ...before, dedupeBatchId: before.dedupeBatchId || '' };
  assert.deepEqual(restored.mergedFrom, priorAudit, 'revert restores the original audit exactly');
  assert.equal(restored.feeRateOverride, 0.025, 'revert restores the fee rate');
});

// ── EXACT same-source duplicates (a CSV imported twice / a double-entry) ──────
// The new second pass. Safety hinges on an EXACT identity match (same DAY + amount +
// direction + category + order # + party + description), so real recurring charges
// (which land on different days) are never collapsed.

test('EXACT DUP: two identical same-source rows → one pair (amount counts once)', () => {
  const a = manual({ _id: 'a', date: '2026-03-10', type: 'income', category: 'Customer Sales', amount: 4852.89, party: 'The CannaBoss Lady', description: 'Invoice #1036', orderNumber: '1036' });
  const b = manual({ _id: 'b', date: '2026-03-10', type: 'income', category: 'Customer Sales', amount: 4852.89, party: 'The CannaBoss Lady', description: 'Invoice #1036', orderNumber: '1036' });
  const plan = buildDedupePlan([a, b], {});
  assert.equal(plan.summary.exactDuplicatePairs, 1);
  assert.equal(plan.pairCount, 1);
  assert.equal(plan.pairs[0].exact, true);
});

test('EXACT DUP: recurring-charge protection — same vendor/amount on DIFFERENT days is NOT merged', () => {
  const jan = manual({ date: '2026-01-15', category: 'Software', amount: 20, party: 'OpenAI', description: 'API' });
  const feb = manual({ date: '2026-02-15', category: 'Software', amount: 20, party: 'OpenAI', description: 'API' });
  assert.equal(buildDedupePlan([jan, feb], {}).pairCount, 0);
});

test('EXACT DUP: receipt copy + identical no-receipt copy → merged, receipt survives', () => {
  const withR  = receipt({ _id: 'r', date: '2026-03-10', type: 'expense', category: 'Printer COGS', amount: 800, party: 'AcmePrint', description: 'job', orderNumber: '1050', receiptUrl: 'r2/p.pdf' });
  const without = manual({ _id: 'n', date: '2026-03-10', type: 'expense', category: 'Printer COGS', amount: 800, party: 'AcmePrint', description: 'job', orderNumber: '1050' });
  const plan = buildDedupePlan([withR, without], {});
  assert.equal(plan.pairCount, 1);
  assert.equal(plan.pairs[0].budget._id, 'r', 'the receipt-bearing copy survives');
  assert.equal(plan.pairs[0].merged.keepsReceipt, true);
});

test('EXACT DUP: a different order # means distinct payments — never merged', () => {
  const a = manual({ date: '2026-03-10', type: 'income', category: 'Customer Sales', amount: 500, party: 'Acme', description: 'pmt', orderNumber: '1001' });
  const b = manual({ date: '2026-03-10', type: 'income', category: 'Customer Sales', amount: 500, party: 'Acme', description: 'pmt', orderNumber: '1002' });
  assert.equal(buildDedupePlan([a, b], {}).pairCount, 0);
});

test('EXACT DUP: { exact:false } disables the pass (cross-source only)', () => {
  const a = manual({ date: '2026-03-10', amount: 100, party: 'X', description: 'd' });
  const b = manual({ date: '2026-03-10', amount: 100, party: 'X', description: 'd' });
  assert.equal(buildDedupePlan([a, b], { exact: false }).pairCount, 0);
});
