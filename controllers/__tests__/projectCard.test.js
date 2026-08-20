// controllers/__tests__/projectCard.test.js
//
//   node --test controllers/__tests__/projectCard.test.js
//
// GET /api/orders/projects used to return every order in full — confirmations,
// quote lines, and the base64 artwork inside them — with no .select() and no
// limit. utils/projectCard.js is what makes that feed a card instead, so these
// PIN the two halves of that contract:
//
//   1. the heavy subtrees are gone, and
//   2. NOTHING else is, and the summaries that replace them carry the exact
//      numbers the board used to compute off the subtrees themselves.
//
// (2) is the one that matters: the board's revenue figure has to stay
// byte-identical to the drawer's, and the card is now where it comes from.

const test = require('node:test');
const assert = require('node:assert/strict');

const { projectCard, HEAVY_FIELDS } = require('../../utils/projectCard');
const { computeConfirmationTotals } = require('../../models/Order');

const item = (qty, unitPrice, extra = {}) => ({
  description: 'Tee', unitCost: 7.75,
  sizes: [{ label: 'OS', qty, unitPrice }],
  ...extra,
});

test('the four heavy subtrees are removed', () => {
  const card = projectCard({
    _id: 'a', projectNumber: '142',
    confirmation: { items: [item(10, 20)] },
    quoteLines: [{ group: 'Tees', qty: 10 }],
    quoteLinesPublished: [{ group: 'Tees', qty: 10 }],
    activity: [{ kind: 'created' }],
  });
  for (const f of HEAVY_FIELDS) assert.equal(f in card, false, `${f} should not survive`);
});

test('every other field passes through verbatim', () => {
  // A card is a REMOVAL, not a whitelist — a field nobody thought about here
  // still has to reach the board, or the next schema addition breaks it.
  const order = {
    _id: 'a', projectNumber: '142', orderNumber: '0000021', status: 'quoted',
    companyName: 'Bleu Leaf', clientName: 'Sam', companyKey: 'bleuleaf',
    items: [{ description: 'Tees' }], mockupNumbers: ['142A'],
    paid: false, optionsPickedAt: new Date('2026-01-02T00:00:00Z'),
    totalValue: 1200.5, cogs: 640.25, orderDate: new Date('2026-01-03T00:00:00Z'),
    printerName: 'Heritage', supplier: 'S&S', tracking: { steps: [] },
    approvalEvents: [{ kind: 'viewed' }], archived: false,
    somethingAddedNextYear: 'still here',
  };
  const card = projectCard({ ...order, confirmation: { items: [] }, quoteLines: [] });
  for (const [k, v] of Object.entries(order)) assert.deepEqual(card[k], v, `${k} changed`);
});

test('confirmation revenue on the card equals the model total to the cent', () => {
  // NJ order with a percent card fee — the shape whose grand total the board
  // and the drawer must agree on. Not "close": equal.
  const conf = {
    items: [item(100, 12.92)],
    customLines: [{ label: 'Card fee', percent: 3.5 }],
  };
  const card = projectCard({ _id: 'a', confirmation: conf });
  assert.equal(card.hasConfirmationItems, true);
  assert.equal(card.confirmationRevenue, computeConfirmationTotals(conf).grandTotal);
});

test('no confirmation → the board falls back to the stored totalValue', () => {
  // hasConfirmationItems false is the signal the card sends for that; revenue
  // is 0 rather than absent so a reader never has to distinguish the two.
  const card = projectCard({ _id: 'a', totalValue: 900, confirmation: { items: [] } });
  assert.equal(card.hasConfirmationItems, false);
  assert.equal(card.confirmationRevenue, 0);
  assert.equal(card.totalValue, 900);
});

test('an order that never had a confirmation or quote lines still cards cleanly', () => {
  const card = projectCard({ _id: 'a', projectNumber: '9' });
  assert.equal(card.hasConfirmationItems, false);
  assert.equal(card.confirmationRevenue, 0);
  assert.equal(card.confirmationPublishedAt, null);
  assert.equal(card.quoteLineCount, 0);
  assert.equal(card.quoteGroupCount, 0);
  assert.equal(card.quoteAcceptedCount, 0);
});

test('quote summaries count lines, distinct option groups and the accepted picks', () => {
  const card = projectCard({
    _id: 'a',
    quoteLines: [
      { group: 'Bucket Hats', accepted: true },
      { group: 'Bucket Hats' },
      { group: '  Bucket Hats  ' },   // same group, sloppy whitespace
      { group: 'Tees' },
      { group: '' },                  // standalone line — not an option set
      {},
    ],
  });
  assert.equal(card.quoteLineCount, 6);
  assert.equal(card.quoteGroupCount, 2);
  assert.equal(card.quoteAcceptedCount, 1);
});

test('publishedAt is carried so the board can tell a published confirmation from a draft', () => {
  const at = new Date('2026-02-01T15:00:00Z');
  const card = projectCard({ _id: 'a', confirmation: { items: [item(5, 10)], publishedAt: at } });
  assert.deepEqual(card.confirmationPublishedAt, at);
});
