// controllers/__tests__/printerNetwork.test.js
//   node --test controllers/__tests__/printerNetwork.test.js
// The printer-network price-review nudge + a structural guard on the committed
// price-book catalogs (so a malformed sheet can't silently seed garbage).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Printer = require('../../models/Printer');

// ── yearly re-verify nudge ──────────────────────────────────────────────────
test('pricingReviewDue: due once a full year has passed since capture', () => {
  const p = { capturedOn: '2026-07-16' };
  assert.equal(Printer.pricingReviewDue(p, new Date(2026, 11, 31)), false, 'same year → not due');
  assert.equal(Printer.pricingReviewDue(p, new Date(2027, 6, 15)), false, 'day before anniversary → not due');
  assert.equal(Printer.pricingReviewDue(p, new Date(2027, 6, 16)), true, 'on the anniversary → due');
  assert.equal(Printer.pricingReviewDue(p, new Date(2028, 0, 1)), true, 'well past → due');
});

test('pricingReviewDue: a re-verify resets the clock', () => {
  const p = { capturedOn: '2026-07-16', pricingReviewedOn: '2027-02-01' };
  assert.equal(Printer.pricingReviewDue(p, new Date(2027, 6, 16)), false, 'reviewed Feb 2027 → not due in Jul 2027');
  assert.equal(Printer.pricingReviewDue(p, new Date(2028, 1, 1)), true, 'a year after the review → due again');
});

test('pricingReviewDue: no capture date on record never nags (legacy printers)', () => {
  assert.equal(Printer.pricingReviewDue({}, new Date(2030, 0, 1)), false);
  assert.equal(Printer.pricingReviewDue({ capturedOn: '' }, new Date(2030, 0, 1)), false);
  assert.equal(Printer.pricingReviewDue(null, new Date(2030, 0, 1)), false);
});

// ── committed price-book catalogs are well-formed ───────────────────────────
const DATA = path.join(__dirname, '..', '..', 'data');
const NEW_CATALOGS = ['printhybrid', 'aplus', 'contractdtg'];

for (const key of NEW_CATALOGS) {
  test(`catalog ${key}: parses with printer meta + capabilities + capture date`, () => {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA, `printerCatalog-${key}.json`), 'utf8'));
    assert.ok(raw.printer, 'has printer block');
    assert.ok(raw.printer.name, 'has name');
    assert.match(raw.printer.state, /^[A-Z]{2}$/, 'has a 2-letter state (nexus fact)');
    assert.ok(Array.isArray(raw.printer.capabilities) && raw.printer.capabilities.length, 'has capabilities');
    assert.ok(Array.isArray(raw.printer.contacts) && raw.printer.contacts.length, 'has at least one contact');
    assert.match(raw.meta.capturedOn, /^\d{4}-\d{2}-\d{2}$/, 'stamped with a capture date for the yearly review');
    // every declared capability that has a price book must carry a self-describing model tag
    for (const [section, body] of Object.entries(raw)) {
      if (section === 'meta' || section === 'printer' || section === 'addOns' || section === 'terms') continue;
      if (body && typeof body === 'object') assert.ok(body.model, `section ${section} declares a pricing model`);
    }
  });
}

test('print hybrid: screen-print setup is baked in, squeegee is qty-only', () => {
  const ph = JSON.parse(fs.readFileSync(path.join(DATA, 'printerCatalog-printhybrid.json'), 'utf8'));
  assert.equal(ph.screenPrinting.setup, 'included');
  assert.equal(ph.screenPrinting.tiers[0].minQty, 48);
  assert.deepEqual(ph.screenPrinting.tiers[0].prices, [4, 4.5, 5.1, 5.7, 7, 7.8, 12, 16]);
  assert.equal(ph.digitalSqueegee.model, 'qty_only');
  assert.equal(ph.digitalSqueegee.tiers.find((t) => t.minQty === 48).price, 8);
});

test('A+ embroidery: full grid, every qty tier spans every stitch band', () => {
  const ap = JSON.parse(fs.readFileSync(path.join(DATA, 'printerCatalog-aplus.json'), 'utf8'));
  const bands = ap.embroidery.stitchBands.length;
  assert.equal(bands, 70);
  for (const tier of ap.embroidery.qtyTiers) {
    assert.equal(ap.embroidery.grid[tier.label].length, bands, `qty ${tier.label} covers all bands`);
  }
  assert.equal(ap.screenPrinting.setup, 'included');
});

test('contract-DTG: DTG carries dark+white per size, DTF is size×qty', () => {
  const cd = JSON.parse(fs.readFileSync(path.join(DATA, 'printerCatalog-contractdtg.json'), 'utf8'));
  assert.equal(cd.dtg.includesGarment, false);
  assert.deepEqual(cd.dtg.tiers[0].prices['4x4'], [6.6, 5.5]); // [dark, white]
  assert.equal(cd.dtf.grid['15x20'].length, cd.dtf.qtyCols.length);
});
