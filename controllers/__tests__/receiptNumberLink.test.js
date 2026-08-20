// controllers/__tests__/receiptNumberLink.test.js
//
// Pins the ORDER-LINK vs INVOICE-NUMBER split in controllers/receipts.js
// receiptNumberPlan() — the fix for the reported bug: a paid client invoice was
// uploaded, read fine, and booked against an order that DOES NOT EXIST, so the real
// job kept reading "cost recorded, no client payment" on the Finances gap panel.
//
//   node --test controllers/__tests__/receiptNumberLink.test.js
//
// The live case: Long Island Sound Custom Boatworks. The invoice printed #1054 (the
// owner's invoice sequence); the job is order #138. The reader hands back one field
// for both kinds of number, so the ONLY thing that can tell them apart is whether the
// number resolves to a real Order.
//
// The contract:
//   • resolves to an Order  → it is an ORDER LINK, stored canonically;
//   • resolves to nothing   → it is the owner's INVOICE NUMBER, never an order link,
//                             and never dropped;
//   • nothing printed       → both blank.

const test = require('node:test');
const assert = require('node:assert/strict');

const { receiptNumberPlan } = require('../receipts');

// ── the regression: an invoice # must never become an order link ─────────────

test('REGRESSION (Custom Boatworks): invoice #1054 matching no order is NOT an order link', () => {
  const plan = receiptNumberPlan('1054', null);
  assert.equal(plan.orderNumber, '', 'a phantom order link must never be booked');
  assert.equal(plan.invoiceNumber, '1054', 'the printed number is kept, not dropped');
  assert.equal(plan.unmatched, true, 'the caller must be able to route this to review');
});

test('the real order # for that same job still links normally', () => {
  const plan = receiptNumberPlan('138', { orderNumber: '138' });
  assert.deepEqual(plan, { orderNumber: '138', invoiceNumber: '', unmatched: false });
});

// ── matched numbers link canonically ─────────────────────────────────────────

test('a matched order stores the CANONICAL key, not the string off the page', () => {
  // Order.orderNumber is free-form ("0000021", "#21", "PO-021"); the ledger joins on
  // the normalized key, so that is what gets written.
  for (const printed of ['PO-021', '#21', '0000021', '21']) {
    const plan = receiptNumberPlan(printed, { orderNumber: '0000021' });
    assert.equal(plan.orderNumber, '21', `${printed} should link as "21"`);
    assert.equal(plan.invoiceNumber, '', 'a matched number is an order link, not an invoice #');
    assert.equal(plan.unmatched, false);
  }
});

test('a matched order never leaves an invoice number behind to double-report', () => {
  const plan = receiptNumberPlan('1052', { orderNumber: '1052' });
  assert.equal(plan.invoiceNumber, '');
});

// ── nothing printed ──────────────────────────────────────────────────────────

test('no number printed → nothing linked, nothing invented, and NOT flagged unmatched', () => {
  for (const empty of ['', null, undefined, '   ', 'no number here']) {
    const plan = receiptNumberPlan(empty, null);
    assert.deepEqual(plan, { orderNumber: '', invoiceNumber: '', unmatched: false },
      `${JSON.stringify(empty)} should yield a clean blank plan`);
  }
});

test('a blank number with an order somehow passed stays blank (digits decide)', () => {
  const plan = receiptNumberPlan('', { orderNumber: '138' });
  assert.equal(plan.orderNumber, '');
  assert.equal(plan.unmatched, false);
});

// ── hardening ────────────────────────────────────────────────────────────────

test('non-digit noise around an unmatched number still yields the digits as the invoice #', () => {
  const plan = receiptNumberPlan('Invoice #1054', null);
  assert.equal(plan.invoiceNumber, '1054');
  assert.equal(plan.orderNumber, '');
});

test('an order doc with a junk/blank number cannot produce a junk link', () => {
  // normalizeOrderNumber strips to digits; a blank order # yields a blank link
  // rather than writing garbage into the ledger's join key.
  const plan = receiptNumberPlan('1054', { orderNumber: '' });
  assert.equal(plan.orderNumber, '');
});

// ── which Order a printed number links to (pickLinkedOrder) ──────────────────
// The number on a receipt is not always the order #. The owner routinely writes the
// PROJECT # instead ("project #140 vs invoice #1049" — the habit finances.js
// enrichTransactionLinks already compensates for downstream). A project # names a
// REAL order, so it is an order link, not an unknown number — otherwise the cost is
// stranded off its job and that job is false-flagged as still missing its receipt.

const { pickLinkedOrder } = require('../receipts');

const ord = (orderNumber, projectNumber = '', companyName = '') =>
  ({ orderNumber, projectNumber, companyName, clientName: '' });

test('an ORDER-# match always beats a project-# match', () => {
  // "140" is order #140's own number AND order #1049's project #. The invoice wins;
  // a number never links to two jobs at once.
  const hit = pickLinkedOrder('140', [ord('140', '9', 'A')], [ord('1049', '140', 'B')]);
  assert.equal(hit.orderNumber, '140');
});

test('REGRESSION: a receipt stamped with the PROJECT # still links to its job', () => {
  const hit = pickLinkedOrder('140', [], [ord('1049', '140', 'Heritage')]);
  assert.equal(hit.orderNumber, '1049', 'project #140 belongs to order #1049');
  // …and it books as a real order link, not as an invoice number.
  assert.deepEqual(receiptNumberPlan('140', hit), { orderNumber: '1049', invoiceNumber: '', unmatched: false });
});

test('an AMBIGUOUS project # links to nothing rather than guessing a job', () => {
  const hit = pickLinkedOrder('140', [], [ord('1049', '140', 'B'), ord('1050', '140', 'C')]);
  assert.equal(hit, null);
  // Ambiguous → it falls back to being kept as the invoice #, never guessed onto a job.
  assert.equal(receiptNumberPlan('140', hit).invoiceNumber, '140');
});

test('duplicate order docs for ONE job are not ambiguous', () => {
  const hit = pickLinkedOrder('140', [], [ord('1049', '140', ''), ord('1049', '140', 'Heritage')]);
  assert.equal(hit.orderNumber, '1049');
  assert.equal(hit.companyName, 'Heritage', 'prefer the NAMED doc so the client resolves');
});

test('a project match on an order with no usable order # is not a link', () => {
  assert.equal(pickLinkedOrder('140', [], [ord('', '140', 'B')]), null);
});

test('nothing found either way → no link', () => {
  assert.equal(pickLinkedOrder('1054', [], []), null);
});

test('on an order-# collision, the NAMED order wins so the client resolves', () => {
  const hit = pickLinkedOrder('138', [ord('138', '', ''), ord('138', '', 'Custom Boatworks')], []);
  assert.equal(hit.companyName, 'Custom Boatworks');
});
