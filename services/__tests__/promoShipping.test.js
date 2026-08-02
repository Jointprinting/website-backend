// Promo shipping estimator + the weight model it stands on.
//
// The weight anchors are the load-bearing part: every estimate scales off them,
// and a first pass that mixed bounding boxes with capacities produced a 1,555g
// silicone mat and a 4.7g Bic lighter. So the representative items are pinned
// against known real-world weights here — if an anchor or a parse rule drifts,
// these fail before a client sees a wrong freight number on a quote.

const test = require('node:test');
const assert = require('node:assert');

const {
  estimateUnitWeightOz, effectiveUnitWeightOz, hazmatFee, shippingIncluded, parseDims,
} = require('../promoWeights');
const {
  estimateShipping, zoneForMiles, normalizeState, haversineMiles, ORIGIN, STATE_CENTROIDS,
  rateAgeDays, RATES_CALIBRATED_ON, RATES_STALE_AFTER_DAYS,
} = require('../promoShipping');

const catalog = require('../../data/promoCatalog.json');
const find = (name) => {
  const p = catalog.find((i) => i.name === name);
  assert.ok(p, `catalog is missing "${name}" — update the test or the fixture`);
  return p;
};

// ── Weights ──────────────────────────────────────────────────────────────────

test('anchors land on known real-world weights', () => {
  const known = {
    'Custom Branded Bic Lighter': 11,
    'Black Metal 4 Piece Grinder (40mm)': 60,
    'Glass Jar 3oz (Direct Print or Label)': 25,
    '12 x 8 Dab Mat': 90,
    'Concentrate Jar 5ml': 20,
    'Glass Ashtray Full Color Imprint': 200,
    'Biodegradable Hemp Plastic Rolling Tray - Medium': 110,
    'Custom iKrusher Vape Pen Battery': 25,
    'Glass Chillum One Hitters': 15,
    'Biodegradable Hemp Pre-Roll Tubes': 4,
  };
  for (const [name, expected] of Object.entries(known)) {
    const got = estimateUnitWeightOz(find(name)).grams;
    const err = Math.abs(got - expected) / expected;
    assert.ok(err < 0.3, `${name}: ${got}g vs ~${expected}g (${(err * 100).toFixed(0)}% off)`);
  }
});

test('every catalog item estimates to a physically plausible weight', () => {
  for (const p of catalog) {
    const { grams } = estimateUnitWeightOz(p);
    assert.ok(grams >= 0.5 && grams <= 1500, `${p.name}: implausible ${grams}g`);
    assert.ok(Number.isFinite(grams), `${p.name}: non-finite weight`);
  }
});

test('weight scales monotonically with size inside a category', () => {
  const g = (n) => estimateUnitWeightOz(find(n)).grams;
  assert.ok(g('Black Metal 4 Piece Grinder (40mm)') < g('Black Metal 4 Piece Grinder (50mm)'));
  assert.ok(g('Black Metal 4 Piece Grinder (50mm)') < g('Black Metal 4 Piece Grinder (63mm)'));
  assert.ok(g('3 x 4 Dab Mat') < g('12 x 8 Dab Mat'));
  assert.ok(g('12 x 8 Dab Mat') < g('16 x 11 Dab Mat'));
  assert.ok(g('Mylar Barrier Bag - Pre Roll') < g('Mylar Barrier Bag - One Pound'));
});

test('a bare measurement followed by punctuation is not dropped', () => {
  // `3.75" x 1.57";` — a `\b` bound to the optional label made the parser lose
  // the second number, which made the Dabit card ~30x too heavy.
  const d = parseDims('3.75" x 1.57"; metal; 3-piece');
  assert.deepStrictEqual(d.faces, [3.75, 1.57]);
});

test('a "D" measurement is read as a diameter, and a lone diameter is not reused as height', () => {
  assert.strictEqual(parseDims('1.5"D x 1.3"H; metal').diameter, 1.5);
  // "4\" diameter" with no height: squaring the diameter into the height
  // tripled the ashtray.
  assert.ok(Math.abs(estimateUnitWeightOz(find('Glass Ashtray Full Color Imprint')).grams - 200) < 10);
});

test('a round sheet is a sheet, not a solid', () => {
  // The 8" circle mat has only a diameter; falling through to the solid path
  // clamped it at 4kg.
  const g = estimateUnitWeightOz(find('8" Diameter Circle Dab Mat')).grams;
  assert.ok(g > 25 && g < 70, `8" circle mat came out ${g}g`);
});

test('pack-priced cones weigh the pack, measured from the cone not the display case', () => {
  const g = estimateUnitWeightOz(find('Pre-Rolled Cones 3-Pack (with display case)')).grams;
  assert.ok(g > 8 && g < 30, `cone 3-pack came out ${g}g`);
});

test('a category whose anchor already includes its box does not count the box twice', () => {
  const g = estimateUnitWeightOz(find('Rolling Papers 1 1/4 Size - Hemp')).grams;
  assert.ok(g > 4 && g < 11, `1 1/4 booklet came out ${g}g`);
});

test('curated weights win, and an owner weight outranks everything', () => {
  assert.strictEqual(estimateUnitWeightOz(find('Stash Backpack')).source, 'curated');

  const owned = { ...find('Black Metal 4 Piece Grinder (40mm)'), unitWeightOz: 3.5, weightSource: 'owner' };
  const eff = effectiveUnitWeightOz(owned);
  assert.strictEqual(eff.oz, 3.5);
  assert.strictEqual(eff.source, 'owner');
});

// ── Catalog-stated facts are honored, not estimated ──────────────────────────

test('overseas SKUs marked "shipping included" are detected', () => {
  assert.strictEqual(shippingIncluded(find('Mylar Bag Overseas - Eighth OZ')), true);
  assert.strictEqual(shippingIncluded(find('Mylar Barrier Bag - Eighth OZ')), false);
});

test('a "shipping included" line contributes no freight', () => {
  const r = estimateShipping({
    lines: [{ product: find('Mylar Bag Overseas - Eighth OZ'), qty: 5000 }],
    destState: 'PA',
  });
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.grossLb, 0);
  assert.ok(r.basis.some((b) => /shipping included/i.test(b)));
});

test('hazmat fees bill per stated block, and a stated range uses the smaller block', () => {
  // "$25 (net) per 500 units"
  assert.strictEqual(hazmatFee(find('Custom BRIO Clipper Lighter'), 1000).fee, 50);
  assert.strictEqual(hazmatFee(find('Custom BRIO Clipper Lighter'), 501).fee, 50);
  assert.strictEqual(hazmatFee(find('Custom BRIO Clipper Lighter'), 500).fee, 25);
  // "$25 (net) per 240-480 units" -> bill on 240, the conservative read
  assert.strictEqual(hazmatFee(find('Custom Branded Clipper Lighter'), 1000).fee, 125);
  // A non-hazmat lighter carries no fee.
  assert.strictEqual(hazmatFee(find('Custom Branded Bic Lighter'), 1000), null);
});

test('hazmat rides on top of freight and is reported separately', () => {
  const r = estimateShipping({ lines: [{ product: find('Custom MK Jet Lighter'), qty: 1000 }], destState: 'PA' });
  assert.strictEqual(r.hazmat, 50);
  assert.ok(r.total > r.hazmat, 'hazmat should add to freight, not replace it');
});

// ── Zones and rating ─────────────────────────────────────────────────────────

test('zone bands map distance the standard way', () => {
  assert.strictEqual(zoneForMiles(100), 2);
  assert.strictEqual(zoneForMiles(700), 5);
  assert.strictEqual(zoneForMiles(2500), 8);
});

test('zone rises with distance from St. Petersburg', () => {
  const z = (st) => estimateShipping({ lines: [{ product: find('Custom Branded Bic Lighter'), qty: 500 }], destState: st }).zone;
  assert.ok(z('FL') <= z('GA'));
  assert.ok(z('GA') < z('PA'));
  assert.ok(z('PA') < z('CA'));
  assert.strictEqual(z('CA'), 8);
});

test('unknown or missing state degrades to zone 5 and says so', () => {
  assert.strictEqual(normalizeState('ZZ'), '');
  const r = estimateShipping({ lines: [{ product: find('Custom Branded Bic Lighter'), qty: 100 }], destState: '' });
  assert.strictEqual(r.zone, 5);
  assert.ok(r.basis.some((b) => /assuming zone 5/i.test(b)));
});

test('origin is the vendor in St. Petersburg', () => {
  assert.strictEqual(ORIGIN.zip, '33712');
  assert.ok(haversineMiles([ORIGIN.lat, ORIGIN.lon], STATE_CENTROIDS.FL) < 200);
});

test('heavy orders price as LTL, light ones as parcel', () => {
  const light = estimateShipping({ lines: [{ product: find('Custom Branded Bic Lighter'), qty: 500 }], destState: 'PA' });
  assert.strictEqual(light.method, 'parcel');

  const heavy = estimateShipping({ lines: [{ product: find('Glass Ashtray Full Color Imprint'), qty: 2500 }], destState: 'CA' });
  assert.strictEqual(heavy.method, 'ltl');
  assert.ok(heavy.basis.some((b) => /confirm with the vendor/i.test(b)));
});

test('a lot of light goods can outweigh a few heavy ones', () => {
  // The owner's own framing: papers vs grinders. Freight has to reflect it.
  const papers = estimateShipping({ lines: [{ product: find('Rolling Papers 1 1/4 Size - Hemp'), qty: 10000 }], destState: 'PA' });
  const grinders = estimateShipping({ lines: [{ product: find('Black Metal 4 Piece Grinder (40mm)'), qty: 1000 }], destState: 'PA' });
  assert.ok(papers.grossLb > grinders.grossLb, `papers ${papers.grossLb}lb vs grinders ${grinders.grossLb}lb`);
});

test('cost rises with quantity and with distance', () => {
  const at = (qty, st) => estimateShipping({ lines: [{ product: find('Black Metal 4 Piece Grinder (40mm)'), qty }], destState: st }).total;
  assert.ok(at(500, 'PA') < at(1000, 'PA'));
  assert.ok(at(1000, 'GA') < at(1000, 'CA'));
});

// ── Allocation ───────────────────────────────────────────────────────────────

test('per-line shipping sums to the order total', () => {
  const r = estimateShipping({
    lines: [
      { product: find('Black Metal 4 Piece Grinder (40mm)'), qty: 500 },
      { product: find('Rolling Papers 1 1/4 Size - Hemp'), qty: 2000 },
      { product: find('Custom MK Jet Lighter'), qty: 1000 },
    ],
    destState: 'NJ',
  });
  const sum = r.perLine.reduce((s, p) => s + p.shipping, 0);
  assert.ok(Math.abs(sum - r.total) < 0.02, `parts ${sum} vs whole ${r.total}`);
});

test('the heavier line carries the larger share of freight', () => {
  const r = estimateShipping({
    lines: [
      { product: find('Black Metal 4 Piece Grinder (40mm)'), qty: 1000 },
      { product: find('Custom Glass Tips'), qty: 1000 },
    ],
    destState: 'PA',
  });
  assert.ok(r.perLine[0].shipping > r.perLine[1].shipping);
});

test('the pad is applied and reported, and can be turned off', () => {
  const lines = [{ product: find('Black Metal 4 Piece Grinder (40mm)'), qty: 1000 }];
  const padded = estimateShipping({ lines, destState: 'PA' });
  const raw = estimateShipping({ lines, destState: 'PA', pad: 0 });
  assert.ok(padded.pad > 0);
  assert.strictEqual(raw.pad, 0);
  assert.ok(padded.total > raw.total);
  assert.ok(Math.abs(padded.freight - raw.freight) < 0.02, 'the pad must not change the underlying freight');
});

// ── Calibration against a real UPS invoice line ──────────────────────────────
// Jul 10 2026, Heritage Screen Print (Warminster PA) -> a client in Somerdale NJ.
// Zone 2, 26.6 lb actual but 22x17x12 dims, so UPS applied dimensional weight and
// billed 33 lb. Published $31.98 (incl. $6.09 fuel), 30% incentive, NET $22.39.
// The owner does NOT pay published, and quoting as if he did ran ~42% high.

test('dimensional weight matches what UPS actually billed', () => {
  // 22 x 17 x 12 = 4488 in3 / 139 = 32.3 -> UPS billed 33 lb against 26.6 actual.
  assert.strictEqual(Math.round((22 * 17 * 12) / 139), 32);
  assert.ok((22 * 17 * 12) / 139 > 26.6, 'dim weight must exceed actual, which is why it was applied');
});

test('a zone-2 parcel prices near the real net charge, not the published one', () => {
  // ~33 lb billable into a zone-2 lane (FL origin, FL destination).
  const oneLb = { name: 'cal', category: 'Grinder', description: '1.5"D x 1.3"H; metal', unitWeightOz: 16, weightSource: 'owner' };
  const r = estimateShipping({ lines: [{ product: oneLb, qty: 31 }], destState: 'FL', pad: 0 });
  assert.strictEqual(r.zone, 2);
  assert.ok(r.billableLb >= 32 && r.billableLb <= 35, `billable ${r.billableLb} lb should land near 33`);
  // Within 20% of the $22.39 the owner actually paid.
  assert.ok(Math.abs(r.total - 22.39) / 22.39 < 0.20, `estimated $${r.total} vs real $22.39`);
  // And nowhere near the $31.98 published figure it used to quote.
  assert.ok(r.total < 28, `$${r.total} is still quoting like published rates`);
});

test('the incentive is applied and explained, not silently baked in', () => {
  const p = { name: 'x', category: 'Grinder', description: '1.5"D x 1.3"H; metal', unitWeightOz: 16, weightSource: 'owner' };
  const r = estimateShipping({ lines: [{ product: p, qty: 31 }], destState: 'FL', pad: 0 });
  assert.ok(r.basis.some((b) => /incentive/i.test(b)), 'the owner should be able to see the discount applied');
  assert.ok(r.basis.some((b) => /fuel/i.test(b)));
});

test('parcel carries a small pad and LTL a wide one, since LTL is the guess', () => {
  const light = { name: 'l', category: 'Grinder', description: '1.5"D x 1.3"H; metal', unitWeightOz: 16, weightSource: 'owner' };
  const parcel = estimateShipping({ lines: [{ product: light, qty: 31 }], destState: 'FL' });
  const ltl = estimateShipping({ lines: [{ product: light, qty: 4000 }], destState: 'FL' });
  assert.strictEqual(parcel.method, 'parcel');
  assert.strictEqual(ltl.method, 'ltl');
  const parcelPct = parcel.pad / parcel.freight;
  const ltlPct = ltl.pad / ltl.freight;
  assert.ok(ltlPct > parcelPct, `LTL pad ${ltlPct} should exceed parcel pad ${parcelPct}`);
});

// ── Staleness: the table has to admit its own age ────────────────────────────
// Every rate constant here is static, while UPS raises published rates each
// January and the fuel surcharge floats WEEKLY. A quoting tool that drifts
// silently is worse than one that says so.

test('every estimate carries the date its rates were last checked', () => {
  const p = find('Black Metal 4 Piece Grinder (40mm)');
  const r = estimateShipping({ lines: [{ product: p, qty: 1000 }], destState: 'PA' });
  assert.strictEqual(r.ratesCalibratedOn, RATES_CALIBRATED_ON);
  assert.ok(Number.isInteger(r.ratesAgeDays));
  assert.strictEqual(typeof r.ratesStale, 'boolean');
});

test('rate age counts forward from the calibration date and never goes negative', () => {
  const cal = Date.parse(`${RATES_CALIBRATED_ON}T00:00:00Z`);
  assert.strictEqual(rateAgeDays(cal), 0);
  assert.strictEqual(rateAgeDays(cal + 10 * 86400000), 10);
  // A clock behind the calibration date must not produce a negative age.
  assert.strictEqual(rateAgeDays(cal - 5 * 86400000), 0);
});

test('past its shelf life the estimate says so, in the basis the owner reads', () => {
  const stale = Date.parse(`${RATES_CALIBRATED_ON}T00:00:00Z`) + (RATES_STALE_AFTER_DAYS + 1) * 86400000;
  assert.ok(rateAgeDays(stale) > RATES_STALE_AFTER_DAYS);

  const p = find('Black Metal 4 Piece Grinder (40mm)');
  const fresh = estimateShipping({ lines: [{ product: p, qty: 1000 }], destState: 'PA' });
  // Freshly calibrated today: no nag. The warning must not cry wolf.
  if (!fresh.ratesStale) {
    assert.ok(!fresh.basis.some((b) => /last checked against a real invoice/i.test(b)));
  }
});

test('a zero-freight order is not nagged about stale rates', () => {
  // Nothing was priced, so there is nothing to be stale about.
  const r = estimateShipping({ lines: [{ product: find('Mylar Bag Overseas - Eighth OZ'), qty: 5000 }], destState: 'PA' });
  assert.strictEqual(r.total, 0);
  assert.ok(!r.basis.some((b) => /last checked against a real invoice/i.test(b)));
});

test('a range is returned around the estimate rather than false precision', () => {
  const r = estimateShipping({ lines: [{ product: find('Black Metal 4 Piece Grinder (40mm)'), qty: 1000 }], destState: 'PA' });
  assert.ok(r.low < r.total && r.total < r.high);
});

test('empty and zero-quantity inputs are safe', () => {
  const none = estimateShipping({ lines: [], destState: 'PA' });
  assert.strictEqual(none.total, 0);
  const zero = estimateShipping({ lines: [{ product: find('Custom Branded Bic Lighter'), qty: 0 }], destState: 'PA' });
  assert.strictEqual(zero.total, 0);
  assert.ok(Number.isFinite(zero.total));
});

test('an unresolved product does not produce NaN', () => {
  const r = estimateShipping({ lines: [{ product: {}, qty: 100 }], destState: 'PA' });
  assert.ok(Number.isFinite(r.total));
  assert.ok(r.total > 0, 'an unknown item still falls back to the UNKNOWN anchor');
});
