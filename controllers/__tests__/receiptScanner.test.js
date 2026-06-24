// controllers/__tests__/receiptScanner.test.js
//
// Guards the receipt-scan DIRECTION (charge vs refund) — the audit finding that
// the AI read could flip `isCredit`, booking an expense as a credit (or back) and
// silently corrupting COGS/profit totals. These are pure-logic checks (no API
// call, no DB) over services/receiptScanner.js:
//
//   node --test controllers/__tests__/receiptScanner.test.js
//
// The contract under test: a refund is recognised ONLY from an explicit
// kind === 'refund' (the tool enum is exactly ['charge','refund']); anything else
// — including a string that merely CONTAINS "credit"/"return" — is a normal
// charge. signed()/the ledger are NOT touched; this pins the INPUT that sets the
// direction so a misread can't reverse a cost.

const test = require('node:test');
const assert = require('node:assert/strict');

const { isRefundKind, mapExtracted } = require('../../services/receiptScanner');

// ── isRefundKind: only an explicit 'refund' counts ───────────────────────────
test('isRefundKind: exact "refund" (any case/whitespace) → true', () => {
  assert.equal(isRefundKind('refund'), true);
  assert.equal(isRefundKind('Refund'), true);
  assert.equal(isRefundKind('  REFUND '), true);
});

test('isRefundKind: a normal charge / empty / nullish → false', () => {
  assert.equal(isRefundKind('charge'), false);
  assert.equal(isRefundKind(''), false);
  assert.equal(isRefundKind(null), false);
  assert.equal(isRefundKind(undefined), false);
});

test('isRefundKind: strings that merely CONTAIN credit/return do NOT flip (the audit bug)', () => {
  // These would have matched the old /refund|credit|return/ regex and wrongly
  // booked a normal expense as a credit that nets DOWN COGS. They must read as a
  // plain charge now.
  assert.equal(isRefundKind('credit card'), false);
  assert.equal(isRefundKind('store credit purchase'), false);
  assert.equal(isRefundKind('line of credit'), false);
  assert.equal(isRefundKind('returned to floor'), false);
  assert.equal(isRefundKind('credit memo applied as charge'), false);
});

// ── mapExtracted: direction is conservative by default ───────────────────────
test('mapExtracted defaults to a charge (isCredit will be false) unless kind=refund', () => {
  // A receipt with a credit-card tender line: kind comes back as 'charge' (or a
  // noisy value) → must NOT become a refund.
  assert.equal(mapExtracted({ vendor: 'SanMar', amount: 250, kind: 'charge' }).kind, 'charge');
  assert.equal(mapExtracted({ vendor: 'SanMar', amount: 250, kind: 'paid by credit card' }).kind, 'charge');
  assert.equal(mapExtracted({ vendor: 'SanMar', amount: 250 }).kind, 'charge');   // kind absent → charge
});

test('mapExtracted recognises a genuine refund (explicit kind=refund)', () => {
  const out = mapExtracted({ vendor: 'SanMar', amount: 80, kind: 'refund', category: 'Blank COGS' });
  assert.equal(out.kind, 'refund');
  assert.equal(out.category, 'Blank COGS');
  assert.equal(out.amount, 80);   // amount stays the positive magnitude
});

test('mapExtracted: direction is carried by `kind`, not by a sign on the amount', () => {
  // The ledger books abs(amount) at confirm time and applies signed() from the
  // direction — so the magnitude here is informational; the refund signal is kind.
  assert.equal(mapExtracted({ vendor: 'X', amount: 50, kind: 'refund' }).amount, 50);
  assert.equal(mapExtracted({ vendor: 'X', amount: 50, kind: 'refund' }).kind, 'refund');
});

// ── mapExtracted: the order-flow fields (seller / billTo / documentKind) ──────
test('mapExtracted carries seller, billTo and a valid documentKind', () => {
  const out = mapExtracted({ seller: 'Joint Printing LLC', billTo: 'NJ Dental 1', documentKind: 'sales_invoice', amount: 100 });
  assert.equal(out.seller, 'Joint Printing LLC');
  assert.equal(out.billTo, 'NJ Dental 1');
  assert.equal(out.documentKind, 'sales_invoice');
});

test('mapExtracted clamps an unknown documentKind to a purchase_receipt; absent billTo → ""', () => {
  assert.equal(mapExtracted({ seller: 'SanMar', amount: 1, documentKind: 'garbage' }).documentKind, 'purchase_receipt');
  assert.equal(mapExtracted({ seller: 'SanMar', amount: 1 }).documentKind, 'purchase_receipt');
  assert.equal(mapExtracted({ seller: 'SanMar', amount: 1 }).billTo, '');
});

test('mapExtracted vendor falls back to a NON-self seller, never to us', () => {
  // A supplier receipt with no explicit vendor → vendor = seller.
  assert.equal(mapExtracted({ seller: 'SanMar', amount: 1, documentKind: 'purchase_receipt' }).vendor, 'SanMar');
  // Our OWN invoice: seller is us → vendor stays blank (we are not the vendor).
  assert.equal(mapExtracted({ seller: 'Joint Printing LLC', amount: 1, documentKind: 'sales_invoice' }).vendor, '');
  // An explicit vendor is preserved as-is.
  assert.equal(mapExtracted({ seller: 'SanMar', vendor: 'SanMar Inc', amount: 1 }).vendor, 'SanMar Inc');
});

// ── confirm() direction precedence (the owner-override contract) ─────────────
// Mirrors the exact rule in controllers/receipts.js confirm(): an explicit owner
// isCredit (top-level body.isCredit, else body.extracted.isCredit) WINS; otherwise
// fall back to the scanned kind. This pins that a confirmed charge can't be
// silently flipped by a stale AI 'kind', and an explicit `false` is honored.
function resolveConfirmIsCredit(body, extractedKind) {
  const owner = typeof body.isCredit === 'boolean'
    ? body.isCredit
    : (body.extracted && typeof body.extracted.isCredit === 'boolean' ? body.extracted.isCredit : null);
  return owner != null ? owner : isRefundKind(extractedKind);
}

test('confirm precedence: explicit owner isCredit (top-level or nested) overrides scan', () => {
  // Scan said refund, but the owner unticked credit → books a normal charge.
  assert.equal(resolveConfirmIsCredit({ isCredit: false }, 'refund'), false);
  assert.equal(resolveConfirmIsCredit({ extracted: { isCredit: false } }, 'refund'), false);
  // Scan said charge, but the owner ticked credit → books a credit.
  assert.equal(resolveConfirmIsCredit({ isCredit: true }, 'charge'), true);
  assert.equal(resolveConfirmIsCredit({ extracted: { isCredit: true } }, 'charge'), true);
});

test('confirm precedence: no owner value → falls back to the (strict) scanned kind', () => {
  assert.equal(resolveConfirmIsCredit({}, 'refund'), true);
  assert.equal(resolveConfirmIsCredit({}, 'charge'), false);
  assert.equal(resolveConfirmIsCredit({ extracted: {} }, 'credit card'), false);  // noisy kind → charge
  assert.equal(resolveConfirmIsCredit({ extracted: { amount: 5 } }, ''), false);  // absent kind → charge
});
