// controllers/__tests__/receiptDecision.test.js
//
// Pins the ORDER-FLOW-AWARE party + direction + type decision in
// services/receiptScanner.js decideTransaction() — the core fix for the reported
// bug (an income invoice booked with party = "Joint Printing LLC"). Pure-logic,
// no DB / no API:
//
//   node --test controllers/__tests__/receiptDecision.test.js
//
// The contract:
//   • our OWN invoice (seller = us)  → income · 'Client Sales' · party = the
//     CLIENT (the linked Order's company, else the bill-to) — NEVER us, BLANK if
//     undeterminable;
//   • a supplier receipt             → expense · party = the vendor we paid;
//   • direction (isCredit) follows the strict scanned kind only (no flip on a
//     noisy "credit card"); a real refund is a credit.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapExtracted, decideTransaction } = require('../../services/receiptScanner');
const { isSelf } = require('../../services/selfIdentity');

// Factories for the raw model output (pre-mapExtracted), mirroring the two doc
// shapes the reader produces.
const salesInvoice = (over = {}) => mapExtracted({
  seller: 'Joint Printing LLC', billTo: 'NJ Dental 1', documentKind: 'sales_invoice',
  vendor: '', amount: 1537.16, orderNumber: '1052', kind: 'charge',
  summary: 'Joint Printing — 129 G2000 tshirts', ...over,
});
const vendorReceipt = (over = {}) => mapExtracted({
  seller: 'SanMar', billTo: '', documentKind: 'purchase_receipt',
  vendor: 'SanMar', category: 'Blank COGS', amount: 250, kind: 'charge', ...over,
});
const order = (over = {}) => ({
  orderNumber: '0001052', companyName: 'NJ Dental 1', clientName: 'Alex Gelman',
  projectNumber: 'P-1052', totalValue: 1537.16, paid: false, ...over,
});

// ── INCOME: our own invoice → client is the party, NEVER us ──────────────────
test('income invoice + linked order → party is the CLIENT (the order is source of truth)', () => {
  const d = decideTransaction(salesInvoice(), order());
  assert.equal(d.type, 'income');
  assert.equal(d.category, 'Client Sales');
  assert.equal(d.party, 'NJ Dental 1');          // the Order's companyName wins
  assert.equal(d.isCredit, false);
  assert.equal(isSelf(d.party), false);          // the bug: self must never be the party
  assert.notEqual(d.party, 'Joint Printing LLC');
});

test('income invoice, no order link → party falls back to the bill-to', () => {
  const d = decideTransaction(salesInvoice(), null);
  assert.equal(d.type, 'income');
  assert.equal(d.party, 'NJ Dental 1');          // from the document's bill-to
});

test('self recognized via SELLER even when documentKind is mislabeled (the bug shape)', () => {
  // The reader put our letterhead in `seller` but tagged it a purchase_receipt.
  // The self seller alone must still flip it to income (never expense w/ us as vendor).
  const d = decideTransaction(salesInvoice({ documentKind: 'purchase_receipt' }), order());
  assert.equal(d.type, 'income');
  assert.equal(d.party, 'NJ Dental 1');
});

test('income invoice where the bill-to is ALSO us, no order → party BLANK (never guess)', () => {
  const d = decideTransaction(salesInvoice({ billTo: 'Joint Printing' }), null);
  assert.equal(d.type, 'income');
  assert.equal(d.party, '');                     // can't determine the client → blank
});

test('income invoice, no order and no bill-to → party BLANK', () => {
  const d = decideTransaction(salesInvoice({ billTo: '' }), null);
  assert.equal(d.type, 'income');
  assert.equal(d.party, '');
});

test('self detected via documentKind alone (seller field empty) → income', () => {
  // No name in seller/vendor, but the reader classified it as our sales invoice
  // and the bill-to is a real client → income with that client.
  const d = decideTransaction(salesInvoice({ seller: '', vendor: '' }), null);
  assert.equal(d.type, 'income');
  assert.equal(d.party, 'NJ Dental 1');
});

// ── EXPENSE: a supplier receipt → vendor is the party ────────────────────────
test('vendor receipt → expense, party is the vendor, category preserved', () => {
  const d = decideTransaction(vendorReceipt(), null);
  assert.equal(d.type, 'expense');
  assert.equal(d.category, 'Blank COGS');
  assert.equal(d.party, 'SanMar');
});

test('vendor receipt linked to an order stays EXPENSE (cost on the order)', () => {
  // A cost receipt carrying an order# must NOT flip to income just because an
  // Order exists — it's still money OUT to the vendor.
  const d = decideTransaction(vendorReceipt({ orderNumber: '1052' }), order());
  assert.equal(d.type, 'expense');
  assert.equal(d.party, 'SanMar');
});

test('vendor receipt that names a customer does NOT flip to income', () => {
  // A supplier invoice may list a customer as a reference; the seller isn't us, so
  // it stays an expense booked to the vendor, ignoring the bill-to.
  const d = decideTransaction(vendorReceipt({ billTo: 'NJ Dental 1' }), null);
  assert.equal(d.type, 'expense');
  assert.equal(d.party, 'SanMar');
});

// ── DIRECTION GUARD (no flip on noise; owner-confirmed handled at confirm()) ──
test('direction: a noisy "credit card" kind stays a charge; a real "refund" is a credit', () => {
  assert.equal(decideTransaction(vendorReceipt({ kind: 'credit card' }), null).isCredit, false);
  assert.equal(decideTransaction(vendorReceipt({ kind: 'store credit' }), null).isCredit, false);
  assert.equal(decideTransaction(vendorReceipt({ kind: 'refund' }), null).isCredit, true);
  assert.equal(decideTransaction(salesInvoice({ kind: 'refund' }), order()).isCredit, true);
});

// ── confirm() owner-override party guard (mirrors controllers/receipts.js) ────
// confirm() lets the owner's posted corrections win, EXCEPT the company itself can
// never become the party even if posted (the whole point of the fix). This pins
// that exact precedence: a blank correction is honored; a self correction is
// rejected back to the order-flow decision; a real correction wins.
function resolveConfirmParty(ownerParty, decidedParty) {
  return (typeof ownerParty === 'string' && (ownerParty.trim() === '' || !isSelf(ownerParty)))
    ? ownerParty
    : decidedParty;
}

test('confirm party: a posted self name is rejected back to the decision (never the company)', () => {
  assert.equal(resolveConfirmParty('Joint Printing', 'NJ Dental 1'), 'NJ Dental 1');
  assert.equal(resolveConfirmParty('Joint Printing LLC', 'NJ Dental 1'), 'NJ Dental 1');
  assert.equal(isSelf(resolveConfirmParty('jointprinting.com', 'NJ Dental 1')), false);
});

test('confirm party: a real correction wins; a blank correction is honored; absent → decision', () => {
  assert.equal(resolveConfirmParty('Acme Co', 'NJ Dental 1'), 'Acme Co');   // owner's real fix wins
  assert.equal(resolveConfirmParty('', 'NJ Dental 1'), '');                  // owner cleared it
  assert.equal(resolveConfirmParty(undefined, 'NJ Dental 1'), 'NJ Dental 1'); // no correction → decision
});
