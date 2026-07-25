// The money gap the Studio could not see.
//
// Invoicing is manual, in QuickBooks, AFTER the client approves:
//   approve → owner writes and sends the invoice → client pays → production.
//
// `paid` alone flattens that into one state, so an approved order parked behind
// an invoice nobody remembered to send looked identical to one already invoiced
// and waiting on the client. That's the most expensive kind of silence in the
// shop — the client has ALREADY said yes.
//
// Two states, two different actions, so the split has to be exact.

const test = require('node:test');
const assert = require('node:assert');

const {
  bucketAwaitingInvoice, bucketInvoiceUnpaid, approvedAtOf, INVOICE_CHASE_DAYS,
} = require('../signals');

const NOW = new Date('2026-07-25T12:00:00Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);

const order = (over = {}) => ({
  _id: 'o1', orderNumber: '44', projectNumber: '000150', companyKey: 'happyleafdispensary',
  companyName: 'Happy Leaf Dispensary', paid: false, invoiceSentAt: null,
  orderDate: daysAgo(3), updatedAt: daysAgo(3),
  approvalEvents: [{ kind: 'approved', at: daysAgo(3) }], approvalSupersededAt: null,
  ...over,
});

// ── Your move: approved, no invoice sent ────────────────────────────────────

test('an approved order with no invoice sent is surfaced', () => {
  const out = bucketAwaitingInvoice([order()], NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].metric, '3d', 'how long they have waited to be billed');
  assert.strictEqual(out[0].orderNumber, '44');
});

test('sending the invoice CLEARS it — the ball moves to the client', () => {
  assert.deepStrictEqual(bucketAwaitingInvoice([order({ invoiceSentAt: daysAgo(1) })], NOW), []);
});

test('a paid order is not chased for an invoice', () => {
  assert.deepStrictEqual(bucketAwaitingInvoice([order({ paid: true })], NOW), []);
});

test('approved today reads as "today", not "0d"', () => {
  const out = bucketAwaitingInvoice([order({
    approvalEvents: [{ kind: 'approved', at: daysAgo(0) }], orderDate: daysAgo(0),
  })], NOW);
  assert.strictEqual(out[0].metric, 'today');
});

test('the longest wait ranks first', () => {
  const out = bucketAwaitingInvoice([
    order({ _id: 'new', companyName: 'New', approvalEvents: [{ kind: 'approved', at: daysAgo(1) }] }),
    order({ _id: 'old', companyName: 'Old', approvalEvents: [{ kind: 'approved', at: daysAgo(20) }] }),
  ], NOW);
  assert.strictEqual(out[0].name, 'Old');
});

// ── Their move: invoice sent, still unpaid ──────────────────────────────────

test('an invoice sent this morning is NOT a problem', () => {
  assert.deepStrictEqual(bucketInvoiceUnpaid([order({ invoiceSentAt: daysAgo(1) })], NOW), []);
});

test('an invoice aged past the chase window is', () => {
  const out = bucketInvoiceUnpaid([order({ invoiceSentAt: daysAgo(INVOICE_CHASE_DAYS + 2) })], NOW);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].note, 'invoice sent, still unpaid');
});

test('exactly at the chase window counts', () => {
  const out = bucketInvoiceUnpaid([order({ invoiceSentAt: daysAgo(INVOICE_CHASE_DAYS) })], NOW);
  assert.strictEqual(out.length, 1);
});

test('paying it clears the chase', () => {
  assert.deepStrictEqual(
    bucketInvoiceUnpaid([order({ paid: true, invoiceSentAt: daysAgo(30) })], NOW), []);
});

test('an un-invoiced order never appears in the chase bucket', () => {
  // The two buckets must not double-count the same order.
  const o = order();
  assert.strictEqual(bucketAwaitingInvoice([o], NOW).length, 1);
  assert.strictEqual(bucketInvoiceUnpaid([o], NOW).length, 0);
});

// ── When did they actually say yes ──────────────────────────────────────────

test('approvedAtOf reads the approval event, not the order date', () => {
  const o = order({ orderDate: daysAgo(30), approvalEvents: [{ kind: 'approved', at: daysAgo(2) }] });
  assert.strictEqual(+approvedAtOf(o), +daysAgo(2));
});

test('an approval from a SUPERSEDED cycle does not count', () => {
  // He re-shared with fresh numbers; that old yes is not the current one.
  const o = order({
    orderDate: daysAgo(9),
    approvalEvents: [{ kind: 'approved', at: daysAgo(20) }],
    approvalSupersededAt: daysAgo(10),
  });
  assert.strictEqual(+approvedAtOf(o), +daysAgo(9), 'falls back to the order date');
});

test('the LATEST approval in the current cycle wins', () => {
  const o = order({ approvalEvents: [
    { kind: 'approved', at: daysAgo(8) },
    { kind: 'viewed', at: daysAgo(1) },
    { kind: 'approved', at: daysAgo(4) },
  ] });
  assert.strictEqual(+approvedAtOf(o), +daysAgo(4));
});

test('non-approval events are ignored', () => {
  const o = order({ orderDate: daysAgo(5), approvalEvents: [{ kind: 'viewed', at: daysAgo(1) }] });
  assert.strictEqual(+approvedAtOf(o), +daysAgo(5));
});

test('handles empty and missing input', () => {
  assert.deepStrictEqual(bucketAwaitingInvoice([], NOW), []);
  assert.deepStrictEqual(bucketAwaitingInvoice(undefined, NOW), []);
  assert.deepStrictEqual(bucketInvoiceUnpaid([], NOW), []);
  assert.deepStrictEqual(bucketInvoiceUnpaid(undefined, NOW), []);
  assert.strictEqual(approvedAtOf(null), null);
});
