// services/__tests__/dataCleanup.test.js
//
// Pins the pure detections behind the owner-run "Fix data" cleanup tool. No DB:
//
//   node --test services/__tests__/dataCleanup.test.js
//
// They must surface ONLY genuine problems (so the owner is never asked to re-enter
// history) and stay conservative — especially the contact-split, which must not
// mangle a legit company name that merely contains a comma.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveCompanyKey, normalizeOrderNumber, splitPollutedName,
  detectOrphanOrders, detectPollutedClients, detectMisKeyedReceipts, detectDuplicateSales,
} = require('../dataCleanup');

const income = (o) => ({ type: 'income', category: 'Customer Sales', ...o });

// ── orphaned orders ──────────────────────────────────────────────────────────
test('detectOrphanOrders: flags named orders with no companyKey, derives the key', () => {
  const r = detectOrphanOrders([
    { _id: 'a', orderNumber: '141', companyName: 'Happy Leaf Dispensary', clientName: '', companyKey: '' },
    { _id: 'b', orderNumber: '140', companyName: 'Coastline', clientName: '', companyKey: 'coastline' }, // already keyed
    { _id: 'c', orderNumber: '99', companyName: '', clientName: '', companyKey: '' },                     // no name → skip
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].orderId, 'a');
  assert.equal(r[0].derivedKey, 'happyleafdispensary');
});

// ── contact-split (the conservative gate) ────────────────────────────────────
test('splitPollutedName: splits only when the left segment IS the stored contact', () => {
  // The real Happy Leaf case.
  assert.deepEqual(
    splitPollutedName('Nathan Vigil, Happy Leaf Dispensary', 'Nathan Vigil'),
    { contact: 'Nathan Vigil', company: 'Happy Leaf Dispensary' },
  );
  // Legit company name with a comma but the left is NOT the contact → never split.
  assert.equal(splitPollutedName('Smith, Jones & Co', 'Dana Park'), null);
  // No comma → nothing to split.
  assert.equal(splitPollutedName('Happy Leaf Dispensary', 'Nathan Vigil'), null);
  // Empty contact → can't confirm pollution → skip.
  assert.equal(splitPollutedName('Nathan Vigil, Happy Leaf', ''), null);
});

test('detectPollutedClients: flags polluted, skips clean + archived', () => {
  const r = detectPollutedClients([
    { _id: 'x', companyKey: 'nathanvigilhappyleafdispensary', companyName: 'Nathan Vigil, Happy Leaf Dispensary', clientName: 'Nathan Vigil' },
    { _id: 'y', companyKey: 'coastline', companyName: 'Coastline', clientName: 'Sam' },                 // clean
    { _id: 'z', companyName: 'Bob, Acme', clientName: 'Bob', archived: true },                          // archived → skip
  ]);
  assert.equal(r.length, 1);
  assert.equal(r[0].clientId, 'x');
  assert.equal(r[0].cleanCompany, 'Happy Leaf Dispensary');
  assert.equal(r[0].contact, 'Nathan Vigil');
});

// ── mis-keyed receipts ───────────────────────────────────────────────────────
test('detectMisKeyedReceipts: flags expense COGS whose order # matches no order', () => {
  const orderKeys = new Set(['1050', '141']);
  const r = detectMisKeyedReceipts([
    { _id: 't1', type: 'expense', category: 'Blank COGS', orderNumber: '#73938537', party: 'S&S Activewear', amount: 482.46 }, // orphan
    { _id: 't2', type: 'expense', category: 'Printer COGS', orderNumber: '1050', amount: 200 },         // links → ok
    { _id: 't3', type: 'income', category: 'Customer Sales', orderNumber: '999', amount: 50 },          // income → ignore
    { _id: 't4', type: 'expense', category: 'Software', orderNumber: '888', amount: 9 },                 // non-COGS → ignore
  ], orderKeys);
  assert.equal(r.length, 1);
  assert.equal(r[0].txnId, 't1');
  assert.equal(r[0].amount, 482.46);
  assert.equal(r[0].party, 'S&S Activewear');
});

test('detectMisKeyedReceipts: budget-import / system rows are never flagged (only hand entries)', () => {
  const orderKeys = new Set(['1050']);
  const r = detectMisKeyedReceipts([
    { _id: 'b', type: 'expense', category: 'Blank COGS', orderNumber: '1', party: 'Alphabroder', amount: 467, source: 'budget' },  // historical import → ignore
    { _id: 'i', type: 'expense', category: 'Shipping', orderNumber: '10', party: 'UPS', amount: 27.4, source: 'import' },           // CSV import → ignore
    { _id: 'a', type: 'expense', category: 'Processing Fee', orderNumber: '106', party: 'JFS', amount: 6.53, source: 'fee:auto' },  // system row → ignore
    { _id: 'm', type: 'expense', category: 'Printer COGS', orderNumber: '88231', party: 'Apollo East', amount: 291.49, source: 'manual' }, // hand-entered → flag
  ], orderKeys);
  assert.equal(r.length, 1);
  assert.equal(r[0].txnId, 'm');
});

test('detectMisKeyedReceipts: leading-zero variants still match a real order', () => {
  const r = detectMisKeyedReceipts(
    [{ _id: 't', type: 'expense', category: 'Blank COGS', orderNumber: '0001050', amount: 10 }],
    new Set(['1050']),
  );
  assert.equal(r.length, 0);
});

// ── duplicate sales (the Happy-Leaf class) ───────────────────────────────────
test('detectDuplicateSales: flags the contact-polluted twin of a real sale, keeps the real one', () => {
  // #1050 is the real order; the same $1,537.16 sale was re-entered under the
  // contact-polluted name + the owner's manual budget order # (which is NOT a real order).
  const orderKeys = new Set(['1050']);
  const r = detectDuplicateSales([
    income({ _id: 'real', orderNumber: '1050', party: 'Happy Leaf Dispensary', amount: 1537.16, date: '2025-03-01' }),
    income({ _id: 'dup', orderNumber: '88231', party: 'Nathan Vigil, Happy Leaf Dispensary', amount: 1537.16, date: '2025-03-10' }),
  ], orderKeys);
  assert.equal(r.length, 1);
  assert.equal(r[0].txnId, 'dup');               // the polluted/orphan row is the duplicate
  assert.equal(r[0].keeper.txnId, 'real');       // anchored to the real #1050 sale
  assert.equal(r[0].orphanOrder, true);          // its order # matches no real order
  assert.equal(r[0].companyKey, 'happyleafdispensary');
});

test('detectDuplicateSales: a polluted twin on its OWN real order # is NOT a duplicate', () => {
  // The owner HABITUALLY books sales as "Contact, Company", so a polluted name on a
  // real, distinct order # is a genuine second sale (a name to clean, not a dup) — it
  // must NEVER be archived. Both rows here are real orders → flag nothing.
  const r = detectDuplicateSales([
    income({ _id: 'real', orderNumber: '1050', party: 'Happy Leaf Dispensary', amount: 1537.16, date: '2025-03-01' }),
    income({ _id: 'other', orderNumber: '1051', party: 'Nathan Vigil, Happy Leaf Dispensary', amount: 1537.16, date: '2025-03-02' }),
  ], new Set(['1050', '1051']));
  assert.equal(r.length, 0);
});

test('detectDuplicateSales: a refund credit is never treated as a duplicate sale', () => {
  // A Customer-Sales credit is a refund (nets revenue DOWN). Archiving it would INFLATE
  // revenue — so it is excluded even when amount + company + orphan order # all line up.
  const r = detectDuplicateSales([
    income({ _id: 'real', orderNumber: '1050', party: 'Happy Leaf Dispensary', amount: 600, date: '2025-03-01' }),
    income({ _id: 'refund', orderNumber: '88231', party: 'Nathan Vigil, Happy Leaf Dispensary', amount: 600, date: '2025-03-05', isCredit: true }),
  ], new Set(['1050']));
  assert.equal(r.length, 0);
});

test('detectDuplicateSales: a BARE-name genuine sale on an orphan/budget # is NOT a duplicate', () => {
  // An orphan order # is the owner's NORMAL state for a manually-booked sale (his budget
  // #s match no Order). A second genuine $600 Happy Leaf sale booked under a budget #,
  // weeks after a real $600 Happy Leaf order, must NOT be archived just because the
  // amount + company + window coincide — the party is bare (no contact pollution), so it
  // lacks the re-entry signature. (Guards the N1 false-positive class.)
  const r = detectDuplicateSales([
    income({ _id: 'real', orderNumber: '1050', party: 'Happy Leaf Dispensary', amount: 600, date: '2025-03-01' }),
    income({ _id: 'genuine2', orderNumber: '88231', party: 'Happy Leaf Dispensary', amount: 600, date: '2025-03-20' }),
  ], new Set(['1050']));
  assert.equal(r.length, 0);
});

test('detectDuplicateSales: a mis-keyed (typo) order # on a bare-name sale is NOT archived', () => {
  // A genuine sale whose order # was fat-fingered to a non-existent number is a re-point
  // case (mis-keyed), NOT a duplicate to delete — bare party → never flagged.
  const r = detectDuplicateSales([
    income({ _id: 'real', orderNumber: '1051', party: 'Happy Leaf Dispensary', amount: 800, date: '2025-03-01' }),
    income({ _id: 'typo', orderNumber: '152', party: 'Happy Leaf Dispensary', amount: 800, date: '2025-03-05' }),
  ], new Set(['1051']));
  assert.equal(r.length, 0);
});

test('detectDuplicateSales: two genuine same-priced orders for one client are NOT flagged', () => {
  // Same company, same amount, but BOTH are real + clean (no orphan, no pollution) →
  // neither is "spurious" → never flagged (the owner really did sell two of these).
  const r = detectDuplicateSales([
    income({ _id: 'a', orderNumber: '1050', party: 'Happy Leaf Dispensary', amount: 1537.16, date: '2025-03-01' }),
    income({ _id: 'b', orderNumber: '1051', party: 'Happy Leaf Dispensary', amount: 1537.16, date: '2025-03-02' }),
  ], new Set(['1050', '1051']));
  assert.equal(r.length, 0);
});

test('detectDuplicateSales: different companies at the same price never collide', () => {
  const r = detectDuplicateSales([
    income({ _id: 'a', orderNumber: '1050', party: 'Happy Leaf Dispensary', amount: 500, date: '2025-03-01' }),
    income({ _id: 'b', orderNumber: '77777', party: 'Bleu Leaf Dispensary', amount: 500, date: '2025-03-02' }),
  ], new Set(['1050']));
  assert.equal(r.length, 0);
});

test('detectDuplicateSales: needs a REAL-order keeper to anchor — two orphans are left alone', () => {
  // Neither row matches a real order, so there is no trustworthy keeper → flag nothing
  // (we never guess which of two unanchored rows is the "real" one).
  const r = detectDuplicateSales([
    income({ _id: 'a', orderNumber: '90001', party: 'Happy Leaf Dispensary', amount: 500, date: '2025-03-01' }),
    income({ _id: 'b', orderNumber: '90002', party: 'Nathan Vigil, Happy Leaf Dispensary', amount: 500, date: '2025-03-02' }),
  ], new Set(['1050']));
  assert.equal(r.length, 0);
});

test('detectDuplicateSales: a far-apart same-priced sale is not treated as a duplicate', () => {
  const r = detectDuplicateSales([
    income({ _id: 'real', orderNumber: '1050', party: 'Happy Leaf Dispensary', amount: 800, date: '2025-01-01' }),
    income({ _id: 'dup', orderNumber: '88231', party: 'Nathan Vigil, Happy Leaf Dispensary', amount: 800, date: '2025-09-01' }),
  ], new Set(['1050']));
  assert.equal(r.length, 0);
});

test('detectDuplicateSales: ignores non-Customer-Sales income and expenses', () => {
  const r = detectDuplicateSales([
    income({ _id: 'real', orderNumber: '1050', party: 'Happy Leaf Dispensary', amount: 200, date: '2025-03-01' }),
    { _id: 'refund', type: 'income', category: 'Refund', orderNumber: '88231', party: 'Nathan Vigil, Happy Leaf Dispensary', amount: 200, date: '2025-03-02' },
    { _id: 'exp', type: 'expense', category: 'Printer COGS', orderNumber: '88231', party: 'Happy Leaf Dispensary', amount: 200, date: '2025-03-02' },
  ], new Set(['1050']));
  assert.equal(r.length, 0);
});

// ── helpers ──────────────────────────────────────────────────────────────────
test('helpers: deriveCompanyKey + normalizeOrderNumber match the rest of the system', () => {
  assert.equal(deriveCompanyKey('Happy Leaf Dispensary', ''), 'happyleafdispensary');
  assert.equal(deriveCompanyKey('', 'Nathan Vigil'), 'nathanvigil');
  assert.equal(normalizeOrderNumber('#0001050'), '1050');
  assert.equal(normalizeOrderNumber('1050'), '1050');
  assert.equal(normalizeOrderNumber('abc'), '');
});
