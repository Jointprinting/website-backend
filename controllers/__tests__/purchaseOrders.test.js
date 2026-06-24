// controllers/__tests__/purchaseOrders.test.js
//
// Pure-logic checks for the PO charge-label cost parser (no DB). Runs on Node's
// built-in test runner — no extra dev deps:
//
//   node --test controllers/__tests__/purchaseOrders.test.js
//
// parseUnitCost is exported from controllers/purchaseOrders.js and takes a plain
// string, so it's testable without Mongo. It feeds the PO builder's "recent
// costs" panel (GET /api/orders/po-cost-history), pulling the per-unit dollar
// figure out of a charge label like "Tee: $2.40/unit * 25 units" -> 2.4. These
// tests PIN that behavior so the panel's unit-cost column can't silently drift.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseUnitCost, _itemShipSplit, _shipNotes, _seedPoForGroup } = require('../purchaseOrders');

// ── the canonical seeded shape ───────────────────────────────────────────────
test('pulls the per-unit figure from a standard charge label', () => {
  assert.equal(parseUnitCost('Tee: $2.40/unit * 25 units'), 2.4);
  assert.equal(parseUnitCost('Run Charge: $2.40/unit * 25 units'), 2.4);
});

// ── tolerances: commas, spacing, singular/plural, missing "$" ─────────────────
test('tolerates thousands commas', () => {
  assert.equal(parseUnitCost('Embroidered jacket: $1,234.50/unit * 10 units'), 1234.5);
  assert.equal(parseUnitCost('$1,000/unit'), 1000);
});

test('tolerates a space around the slash and either side of "unit"', () => {
  assert.equal(parseUnitCost('$2.40 /unit * 25 units'), 2.4);
  assert.equal(parseUnitCost('$2.40/ unit'), 2.4);
  assert.equal(parseUnitCost('$2.40 / unit'), 2.4);
});

test('accepts singular and plural unit(s)', () => {
  assert.equal(parseUnitCost('$3/unit'), 3);
  assert.equal(parseUnitCost('$3/units'), 3);
});

test('does not require a leading "$"', () => {
  assert.equal(parseUnitCost('2.40/unit * 25 units'), 2.4);
});

test('handles whole-dollar and fractional-cent figures', () => {
  assert.equal(parseUnitCost('Setup blanks: $12/unit * 50 units'), 12);
  assert.equal(parseUnitCost('$0.075/unit'), 0.075);
});

// ── absence -> null ──────────────────────────────────────────────────────────
test('returns null when there is no per-unit figure', () => {
  assert.equal(parseUnitCost('Item set-up fee'), null);
  assert.equal(parseUnitCost('Flat rush charge $50'), null);
  assert.equal(parseUnitCost('Freight'), null);
  assert.equal(parseUnitCost(''), null);
  assert.equal(parseUnitCost(null), null);
  assert.equal(parseUnitCost(undefined), null);
});

test('does not match "unit" without a number/slash (e.g. prose)', () => {
  assert.equal(parseUnitCost('Per unit pricing TBD'), null);
  assert.equal(parseUnitCost('25 units total'), null);
});

// ── first per-unit figure wins when a label is unusual ───────────────────────
test('takes the figure attached to /unit, not other dollar amounts', () => {
  // "$60" is the line total, "$2.40/unit" is the per-unit — we want 2.4.
  assert.equal(parseUnitCost('Run Charge $60: $2.40/unit * 25 units'), 2.4);
});

// ── Multi-ship-to: per-item split line (logistics overlay; no money) ─────────
// _itemShipSplit turns an item's allocations into a vendor-readable
// "Ship split — Loc A: 20, Loc B: 15" detail line. It must stay silent for
// single-location orders so the PO output is byte-identical to today.
const SHIP_TOS = [
  { key: 'a', label: 'Brooklyn HQ',  street: '1 Front St',   cityStateZip: 'Brooklyn, NY 11201', state: 'NY' },
  { key: 'b', label: 'Newark Store', street: '22 Market St', cityStateZip: 'Newark, NJ 07102',   state: 'NJ' },
];

test('builds a per-location split line from item allocations', () => {
  const it = { allocations: [{ key: 'a', qty: 20 }, { key: 'b', qty: 15 }] };
  assert.equal(_itemShipSplit(it, SHIP_TOS), 'Ship split — Brooklyn HQ: 20, Newark Store: 15');
});

test('split line falls back to recipient/city when a destination has no label', () => {
  const tos = [{ key: 'a', name: 'Acme Receiving' }, { key: 'b', cityStateZip: 'Newark, NJ 07102' }];
  const it = { allocations: [{ key: 'a', qty: 5 }, { key: 'b', qty: 7 }] };
  assert.equal(_itemShipSplit(it, tos), 'Ship split — Acme Receiving: 5, Newark, NJ 07102: 7');
});

test('split line omits zero / unknown-key allocations and is empty for single-location', () => {
  // Zero qty and an allocation to a key that is not a real destination drop out.
  const it = { allocations: [{ key: 'a', qty: 20 }, { key: 'b', qty: 0 }, { key: 'zzz', qty: 99 }] };
  assert.equal(_itemShipSplit(it, SHIP_TOS), 'Ship split — Brooklyn HQ: 20');
  // No destinations at all → never any split line (single-location, unchanged).
  assert.equal(_itemShipSplit({ allocations: [{ key: 'a', qty: 20 }] }, []), '');
  assert.equal(_itemShipSplit({}, SHIP_TOS), '');
});

test('_shipNotes rosters destinations, empty when none', () => {
  assert.equal(_shipNotes([]), '');
  const note = _shipNotes(SHIP_TOS);
  assert.match(note, /^Shipping to 2 locations:/);
  assert.match(note, /• Brooklyn HQ — 1 Front St, Brooklyn, NY 11201/);
  assert.match(note, /• Newark Store — 22 Market St, Newark, NJ 07102/);
});

// ── Multi-ship-to: PO seed stays byte-identical for single-location ──────────
test('_seedPoForGroup output is unchanged when there are no shipTos', () => {
  const order = {
    companyName: 'Acme', clientName: 'Jane',
    confirmation: { shipping: { name: 'Acme', attention: 'Jane', streetAddress: '1 Front St', cityStateZip: 'Brooklyn, NY 11201' } },
  };
  const item = { brandName: 'Bella', styleCode: '3001', color: 'Black', printType: 'Screen Print',
    unitCost: 4, sizes: [{ label: 'M', qty: 10 }, { label: 'L', qty: 15 }] };
  const seeded = _seedPoForGroup(order, 'Heritage', [item]);
  // No notes added, no extra detail line beyond print/size-run/cost.
  assert.equal(seeded.notes, undefined);
  assert.deepEqual(seeded.items[0].details, ['Screen Print · Black', 'M: 10 · L: 15', '$4.00/unit * 25 units = $100.00']);
  assert.equal(seeded.charges[0].amount, 100);
});

test('_seedPoForGroup appends split detail + notes when shipTos present', () => {
  const order = {
    companyName: 'Acme', clientName: 'Jane',
    confirmation: {
      shipping: { name: 'Acme', attention: 'Jane', streetAddress: '1 Front St', cityStateZip: 'Brooklyn, NY 11201' },
      shipTos: SHIP_TOS,
    },
  };
  const item = { brandName: 'Bella', styleCode: '3001', color: 'Black', printType: 'Screen Print',
    unitCost: 4, sizes: [{ label: 'M', qty: 10 }, { label: 'L', qty: 15 }],
    allocations: [{ key: 'a', qty: 20 }, { key: 'b', qty: 5 }] };
  const seeded = _seedPoForGroup(order, 'Heritage', [item]);
  assert.ok(seeded.items[0].details.includes('Ship split — Brooklyn HQ: 20, Newark Store: 5'));
  assert.match(seeded.notes, /^Shipping to 2 locations:/);
  // Money is untouched — charge still reflects qty × unitCost from sizes only.
  assert.equal(seeded.charges[0].amount, 100);
});
