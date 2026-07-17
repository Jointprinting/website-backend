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
const NEW_CATALOGS = ['printhybrid', 'aplus', 'contractdtg', 'branded'];

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

test('A+ DTF: full qty×sqin grid — complete, monotonic, exact spot cells', () => {
  const ap = JSON.parse(fs.readFileSync(path.join(DATA, 'printerCatalog-aplus.json'), 'utf8'));
  const dtf = ap.dtf;
  assert.equal(dtf.model, 'qty_x_size_sqin');
  assert.ok(!('_needsFullGrid' in dtf), 'the grid is finalized (no pending flag)');
  const bands = dtf.sizeBandsSqin;
  assert.equal(bands.length, 60, '60 five-sqin bands, 5..300');
  assert.equal(bands[0], 5);
  assert.equal(bands[bands.length - 1], 300);
  assert.equal(dtf.qtyTiers.length, 7);

  // every tier covers every band …
  for (const t of dtf.qtyTiers) assert.equal(dtf.grid[t].length, bands.length, `tier ${t} spans all bands`);
  // … price rises with size within a tier …
  for (const t of dtf.qtyTiers) {
    for (let i = 1; i < bands.length; i++) {
      assert.ok(dtf.grid[t][i] >= dtf.grid[t][i - 1], `tier ${t} non-decreasing across bands`);
    }
  }
  // … and falls (bulk discount) as qty grows within a band.
  for (let i = 0; i < bands.length; i++) {
    for (let j = 1; j < dtf.qtyTiers.length; j++) {
      const hi = dtf.grid[dtf.qtyTiers[j - 1]][i];
      const lo = dtf.grid[dtf.qtyTiers[j]][i];
      assert.ok(lo <= hi, `band ${bands[i]} non-increasing across qty tiers`);
    }
  }

  // exact cells verified against the sheet (page 3 of 9, 6/8/26)
  const at = (tier, sqin) => dtf.grid[tier][bands.indexOf(sqin)];
  assert.equal(at('1-11', 300), 17.85);
  assert.equal(at('12-24', 20), 0.96);
  assert.equal(at('25-49', 65), 3.13);
  assert.equal(at('50-99', 135), 5.96);
  assert.equal(at('150-249', 200), 6.91);
  assert.equal(at('250+', 300), 8.93);

  // apply fees + gang-sheet + recommended max carried through
  assert.equal(dtf.applyToFlat, 2.5);
  assert.equal(dtf.applyToNonFlat, 3.5);
  assert.equal(dtf.gangSheetPerLinearFoot, 8);
  assert.equal(dtf.maxRecommendedSqin, 252);
});
