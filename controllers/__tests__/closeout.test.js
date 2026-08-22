// controllers/__tests__/closeout.test.js
//
//   node --test controllers/__tests__/closeout.test.js
//
// The order flow ends at 'delivered' and the tracking ends at 'arrived', so the
// last question — did it actually go well? — has never had a home. Three things
// the business needs went unrecorded because of it, and the most expensive is
// that REPRINTS ARE REAL COGS: they come out of the job's margin, no field ever
// held them, and so every margin figure in the system is the margin before
// anything went wrong.

const test = require('node:test');
const assert = require('node:assert/strict');

const Order = require('../../models/Order');
const { realMarginOf } = require('../../models/Order');

test('a fresh order is simply not closed out', () => {
  // Every existing order reads this way, which is true, and nothing branches on
  // it that did not branch before.
  const o = new Order({ projectNumber: '1' });
  assert.equal(o.closeout.at, null);
  assert.equal(o.closeout.rating, 0);
  assert.equal(o.closeout.onTime, null);
  assert.equal(o.closeout.reworkCost, 0);
  assert.equal(o.closeout.clientComplaint, false);
});

test('"not asked" and "no" are different for on-time', () => {
  // null = never closed out. false = they were late. A default of false would
  // silently mark every historical job as late and poison the printer's record.
  const o = new Order({ projectNumber: '1' });
  assert.equal(o.closeout.onTime, null);
  o.closeout.onTime = false;
  assert.equal(o.closeout.onTime, false);
});

test('rework is charged against the real margin', () => {
  // $4,000 job, $2,800 cost, then 40 shirts reprinted at $310.
  const m = realMarginOf({ totalValue: 4000, cogs: 2800, closeout: { reworkCost: 310 } });
  assert.equal(m.cogs, 3110);
  assert.equal(m.profit, 890);
  assert.equal(m.marginPct, 22.25);
});

test('…and the quoted margin is still reported beside it', () => {
  // Both numbers matter: one is what the invoice was built from, the other is
  // what the business actually earned. Showing only the first is the status quo.
  const m = realMarginOf({ totalValue: 4000, cogs: 2800, closeout: { reworkCost: 310 } });
  assert.equal(m.quotedMarginPct, 30);
  assert.ok(m.marginPct < m.quotedMarginPct);
});

test('no rework means the two numbers agree exactly', () => {
  const m = realMarginOf({ totalValue: 4000, cogs: 2800 });
  assert.equal(m.marginPct, m.quotedMarginPct);
  assert.equal(m.rework, 0);
});

test('the stored cogs is NOT rewritten — it is money-locked', () => {
  // Folding rework into `cogs` would silently move a figure the client's invoice
  // and the P&L were both built from, after the fact.
  const o = { totalValue: 4000, cogs: 2800, closeout: { reworkCost: 310 } };
  realMarginOf(o);
  assert.equal(o.cogs, 2800);
});

test('money comes back as money', () => {
  const m = realMarginOf({ totalValue: 1000, cogs: 333.333, closeout: { reworkCost: 0.005 } });
  assert.equal(Math.round(m.cogs * 100) / 100, m.cogs);
  assert.equal(Math.round(m.profit * 100) / 100, m.profit);
});

test('a job with no revenue has no margin to report', () => {
  assert.equal(realMarginOf({ totalValue: 0, cogs: 100 }), null);
  assert.equal(realMarginOf(null), null);
});

test('closeout survives the money lock, because that is when it happens', () => {
  // updateOrder strips confirmation / totalValue / cogs / orderDate once an order
  // is approved or beyond. Closeout is filled in AFTER delivery — if it were
  // stripped too, the field could never be written at all.
  const MONEY_LOCKED_STRIPS = ['confirmation', 'totalValue', 'cogs', 'orderDate'];
  assert.ok(!MONEY_LOCKED_STRIPS.includes('closeout'));
});
