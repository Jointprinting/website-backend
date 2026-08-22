// controllers/__tests__/businessStats.test.js
//
//   node --test controllers/__tests__/businessStats.test.js
//
// The owner: "theres gotta be so much data im missing that can be useufl also
// like how poplar products are. maybe just having stats overall."
//
// None of this collects anything new — every number comes from fields the system
// has stored all along. The reason none of it was answerable is that nothing
// ever aggregated across orders.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  productPopularity, winRateBySource, printerPerformance, reorderRate, productKey,
} = require('../businessStats');

test('a product is counted ONCE PER ORDER, not once per quote line', () => {
  // A design grid pitching one shirt at 50/100/150 is three lines and one
  // product. Counting lines would rank whatever the owner happened to offer the
  // most tiers of, which is a fact about his quoting habits, not his business.
  const { mostQuoted } = productPopularity([{
    quoteLines: [
      { description: 'Gildan 5000', qty: 50 },
      { description: 'Gildan 5000', qty: 100 },
      { description: 'Gildan 5000', qty: 150 },
    ],
  }]);
  assert.equal(mostQuoted.length, 1);
  assert.equal(mostQuoted[0].orders, 1);
});

test('spelling and spacing do not split one product in two', () => {
  assert.equal(productKey({ description: 'Gildan 5000' }), productKey({ description: '  gildan   5000 ' }));
});

test('a line hidden from the client is not a product you pitched', () => {
  const { mostQuoted } = productPopularity([{
    quoteLines: [{ description: 'Internal costing row', hiddenFromClient: true }],
  }]);
  assert.equal(mostQuoted.length, 0);
});

test('units and revenue come from the CONFIRMATION, which is what was agreed', () => {
  const { mostOrdered } = productPopularity([{
    confirmation: { items: [{ description: 'Gildan 5000', unitPrice: 12,
      sizes: [{ qty: 30 }, { qty: 20 }] }] },
  }]);
  assert.equal(mostOrdered[0].units, 50);
  assert.equal(mostOrdered[0].revenue, 600);
});

test('untagged leads are reported separately, not lumped into a bucket', () => {
  // Until the new picker gets used, untagged is almost everyone — putting them
  // in a bucket would drown the real channels and make the panel useless on day
  // one.
  const clients = [
    { companyKey: 'a', leadSource: 'Referral' },
    { companyKey: 'b', leadSource: 'Referral' },
    { companyKey: 'c', leadSource: '' },
    { companyKey: 'd' },
  ];
  const { rows, untagged } = winRateBySource(clients, new Set(['a']));
  assert.equal(untagged, 2);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'Referral');
  assert.equal(rows[0].winRatePct, 50);
});

test('a channel with no wins reports 0%, not null', () => {
  // 0% is a finding. null would read as "no data" and hide a channel that is
  // costing money and returning nothing.
  const { rows } = winRateBySource([{ companyKey: 'x', leadSource: 'Advertising' }], new Set());
  assert.equal(rows[0].winRatePct, 0);
});

test('only CLOSED-OUT jobs count toward a printer record', () => {
  // An order nobody reviewed says nothing about the printer. Treating silence as
  // success would make every printer look perfect.
  const rows = printerPerformance([
    { printerName: 'Heritage', closeout: { at: new Date(), onTime: true, rating: 5 } },
    { printerName: 'Heritage', closeout: { at: null } },          // never closed out
    { printerName: 'Heritage' },                                   // no closeout at all
  ]);
  assert.equal(rows[0].jobs, 1);
  assert.equal(rows[0].onTimePct, 100);
});

test('late jobs and reprints show up against the printer that caused them', () => {
  const rows = printerPerformance([
    { printerName: 'Heritage', closeout: { at: new Date(), onTime: true, rating: 5 } },
    { printerName: 'Heritage', closeout: { at: new Date(), onTime: false, rating: 2, reprintQty: 40, reworkCost: 310, clientComplaint: true } },
  ]);
  assert.equal(rows[0].jobs, 2);
  assert.equal(rows[0].onTimePct, 50);
  assert.equal(rows[0].avgRating, 3.5);
  assert.equal(rows[0].reprints, 40);
  assert.equal(rows[0].reworkCost, 310);
  assert.equal(rows[0].complaints, 1);
});

test('an unrated job does not drag the average to zero', () => {
  const rows = printerPerformance([
    { printerName: 'H', closeout: { at: new Date(), rating: 4 } },
    { printerName: 'H', closeout: { at: new Date(), rating: 0 } },   // closed out, not rated
  ]);
  assert.equal(rows[0].avgRating, 4);
});

test('a reorder is a COMPANY that came back, not a second order', () => {
  const r = reorderRate([
    { companyKey: 'bleu' }, { companyKey: 'bleu' }, { companyKey: 'bleu' },
    { companyKey: 'acme' },
  ]);
  assert.equal(r.companies, 2);
  assert.equal(r.repeat, 1);
  assert.equal(r.reorderRatePct, 50);
});

test('no data reports null, never a confident zero', () => {
  // "Nothing has been tagged yet" and "your win rate is 0%" are different
  // answers, and only one of them is true on an empty book.
  assert.equal(reorderRate([]).reorderRatePct, null);
  assert.deepEqual(printerPerformance([]), []);
  assert.deepEqual(productPopularity([]).mostQuoted, []);
});

test('junk rows never throw', () => {
  assert.doesNotThrow(() => productPopularity([null, {}, { quoteLines: [null] }]));
  assert.doesNotThrow(() => printerPerformance([null, {}]));
  assert.doesNotThrow(() => winRateBySource([null], new Set()));
});
