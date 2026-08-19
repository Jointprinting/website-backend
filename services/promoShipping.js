// services/promoShipping.js
//
// The freight engine for BOTH legs the owner actually pays for. Named for the
// promo case it was built for; it now rates apparel too, because both ship on
// the same UPS account at the same negotiated rates and only the origin differs:
//
//   APPAREL — the printer who decorated the job ships straight to the client
//             (docs/ECOSYSTEM.md step 9), billed THIRD-PARTY TO THE OWNER'S UPS
//             ACCOUNT. His rates apply, so this is priced at his real net.
//             Origin is Printer.state.
//   PROMO   — Cannabis Promotions ships on THEIR OWN carrier account and
//             invoices the owner the freight afterwards. His UPS incentive does
//             NOT apply, and their rate (and whatever they add on top) is not
//             something we have seen. Priced as an unknown pass-through: see
//             `billedBy` below.
//
// Both are ONE leg. Blanks moving supplier -> printer are deliberately not
// modeled: the owner gets those freight-free, so adding a leg would invent a
// cost he does not pay.
//
// WHY: the vendor catalog prices carry the owner's margin but NOT freight, so
// before this every promo quote either guessed or silently ate the shipping.
//
// HOW: total the line weights (services/promoWeights.js), pack them into
// cartons, take the greater of actual and dimensional weight per carton, work
// out the zone from the origin/destination distance, and rate it. Above the
// parcel ceiling it prices as LTL freight instead, because promo MOQs of
// 5,000-25,000 units routinely land in pallet territory.
//
// TWO THINGS THE CATALOG ALREADY STATES ARE HONORED, NOT ESTIMATED:
//   • hazmat ship fees on butane lighters ($25/blk) are real published charges,
//     added verbatim on top of the freight estimate;
//   • overseas mylar SKUs marked "shipping included" contribute zero freight —
//     estimating any would overcharge the client.
//
// ACCURACY: parcel roughly +/-30%; LTL looser, since real freight is negotiated.
// This autofills a number the owner reviews and can overwrite. It is not a rate
// quote. Every result carries a `basis` array explaining how it got there.

const { effectiveUnitWeightOz, hazmatFee, shippingIncluded } = require('./promoWeights');

const OZ_PER_LB = 16;

// Cannabis Promotions — 2460 5th Ave S Ste A, St. Petersburg, FL 33712.
const ORIGIN = { zip: '33712', city: 'St. Petersburg, FL', lat: 27.7503, lon: -82.6626 };

// Geographic centers, good enough to resolve a zone band. A full ship-to ZIP
// would be better; `estimateShipping` accepts one and falls back to the state.
const STATE_CENTROIDS = {
  AL: [32.7794, -86.8287], AK: [64.0685, -152.2782], AZ: [34.2744, -111.6602],
  AR: [34.8938, -92.4426], CA: [37.1841, -119.4696], CO: [38.9972, -105.5478],
  CT: [41.6219, -72.7273],  DE: [38.9896, -75.5050],  DC: [38.9101, -77.0147],
  FL: [28.6305, -82.4497],  GA: [32.6415, -83.4426],  HI: [20.2927, -156.3737],
  ID: [44.3509, -114.6130], IL: [40.0417, -89.1965],  IN: [39.8942, -86.2816],
  IA: [42.0751, -93.4960],  KS: [38.4937, -98.3804],  KY: [37.5347, -85.3021],
  LA: [31.0689, -91.9968],  ME: [45.3695, -69.2428],  MD: [39.0550, -76.7909],
  MA: [42.2596, -71.8083],  MI: [44.3467, -85.4102],  MN: [46.2807, -94.3053],
  MS: [32.7364, -89.6678],  MO: [38.3566, -92.4580],  MT: [47.0527, -109.6333],
  NE: [41.5378, -99.7951],  NV: [39.3289, -116.6312], NH: [43.6805, -71.5811],
  NJ: [40.1907, -74.6728],  NM: [34.4071, -106.1126], NY: [42.9538, -75.5268],
  NC: [35.5557, -79.3877],  ND: [47.4501, -100.4659], OH: [40.2862, -82.7937],
  OK: [35.5889, -97.4943],  OR: [43.9336, -120.5583], PA: [40.9946, -77.6047],
  RI: [41.6762, -71.5562],  SC: [33.9169, -80.8964],  SD: [44.4443, -100.2263],
  TN: [35.8580, -86.3505],  TX: [31.4757, -99.3312],  UT: [39.3055, -111.6703],
  VT: [44.0687, -72.6658],  VA: [37.5215, -78.8537],  WA: [47.3826, -120.4472],
  WV: [38.6409, -80.6227],  WI: [44.6243, -89.9941],  WY: [42.9957, -107.5512],
  PR: [18.2208, -66.5901],
};

// Standard ground zone bands by origin-destination distance.
const ZONE_BANDS = [
  { zone: 2, maxMiles: 150 },  { zone: 3, maxMiles: 300 },
  { zone: 4, maxMiles: 600 },  { zone: 5, maxMiles: 1000 },
  { zone: 6, maxMiles: 1400 }, { zone: 7, maxMiles: 1800 },
  { zone: 8, maxMiles: Infinity },
];

// Published-retail-shaped ground rates: cost = base + perLb * billable lb.
// Deliberately un-discounted — a quote should not come in under the real bill.
const PARCEL_RATES = {
  2: { base: 9.50,  perLb: 0.55 }, 3: { base: 10.20, perLb: 0.68 },
  4: { base: 11.00, perLb: 0.85 }, 5: { base: 11.80, perLb: 1.05 },
  6: { base: 12.60, perLb: 1.25 }, 7: { base: 13.50, perLb: 1.45 },
  8: { base: 14.50, perLb: 1.70 },
};

// Fuel, as a percentage of the transportation charge. Calibrated against a real
// invoice line: 33 lb, zone 2, published transportation $25.89 + $6.09 fuel.
const FUEL_SURCHARGE_PCT = 0.235;

// The owner's negotiated UPS discount. The rate table above is PUBLISHED pricing
// and he does not pay published — a July 2026 invoice line shows a flat 30% off
// both transportation and fuel ($31.98 published -> $22.39 net). Quoting off
// published made the estimate ~42% high, which loses jobs just as surely as
// under-quoting loses margin. Override with UPS_INCENTIVE_PCT when the discount
// changes; set it to 0 to quote at published.
const ACCOUNT_INCENTIVE_PCT = clampPct(process.env.UPS_INCENTIVE_PCT, 0.30);

function clampPct(raw, fallback) {
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v < 1 ? v : fallback;
}

// LTL freight, dollars per hundredweight, plus a fuel surcharge and a floor.
const LTL_CWT = { 2: 22, 3: 26, 4: 32, 5: 38, 6: 44, 7: 50, 8: 58 };
const LTL_MIN_CHARGE = 145;
const LTL_FUEL_SURCHARGE = 1.28;

// WHEN THIS TABLE WAS LAST CHECKED AGAINST A REAL BILL. Everything above is
// static, and two forces pull it out of true:
//   • UPS raises published rates roughly every January (~5-6%);
//   • the fuel surcharge floats WEEKLY — 23.5% here came off one July invoice.
// A quoting tool that drifts silently is worse than one that admits it, so an
// estimate reports its own age and says so once it is past its shelf life.
// Re-calibrating is a five-minute job: open any recent invoice, compare the net
// charge against what the estimator predicts, and update these constants.
const RATES_CALIBRATED_ON = '2026-08-02';
const RATES_STALE_AFTER_DAYS = 180;

const CARTON_MAX_LB = 40;         // what a picker will actually build
const CARTON_USABLE_IN3 = 2600;   // ~18x14x12 less dunnage
const DIM_DIVISOR = 139;          // standard domestic dimensional divisor
const PACKAGING_OVERHEAD = 1.08;  // box, void fill, tape
const PARCEL_CEILING_LB = 150;    // above this it moves as freight, not parcel

// Safety margin, by how certain the underlying number is.
// Parcel is now calibrated against a real invoice line (published rates + fuel,
// less the account incentive), so it only needs a small cushion. LTL is still a
// genuine unknown — real freight is negotiated per shipment — so it keeps a
// wide one. A single flat 15% on top of uncalibrated published rates was
// running ~42% over what the owner actually pays, which loses jobs.
const DEFAULT_PAD = 0.08;
const LTL_PAD = 0.20;

function haversineMiles(a, b) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function zoneForMiles(miles) {
  for (const b of ZONE_BANDS) if (miles <= b.maxMiles) return b.zone;
  return 8;
}

// How stale the rate table is, in days. Exported so the Studio can badge it.
function rateAgeDays(now) {
  const then = Date.parse(`${RATES_CALIBRATED_ON}T00:00:00Z`);
  const ref = now === undefined ? Date.now() : now;
  if (!Number.isFinite(then)) return 0;
  return Math.max(0, Math.floor((ref - then) / 86400000));
}

function normalizeState(s) {
  const v = String(s || '').trim().toUpperCase();
  return STATE_CENTROIDS[v] ? v : '';
}

/**
 * Ballpark freight for a set of promo quote lines.
 *
 * @param {Object}  input
 * @param {Array}   input.lines      [{ product, qty }] — product is a PromoProduct-shaped
 *                                   object (needs category/description/name/flags, and
 *                                   unitWeightOz/weightSource when known).
 * @param {string}  input.destState  USPS code, e.g. "PA". Falls back to zone 5 when absent.
 * @param {number} [input.pad]       safety margin, default 0.15.
 * @returns {Object} estimate with a per-line allocation and an explainable basis.
 */
// WHOSE ACCOUNT THE FREIGHT IS BILLED TO. This is not cosmetic — it decides
// whether the owner's negotiated UPS discount applies at all.
//   'owner'  — billed to his UPS account (every apparel printer). His 30% is real.
//   'vendor' — the vendor ships on their own account and invoices him after
//              (Cannabis Promotions). His incentive does NOT apply. Their rate is
//              probably better than his (they ship constantly) but they mark it
//              up when they rebill, and we have seen neither number. So the point
//              estimate stays near his own net — the two effects roughly cancel —
//              and the RANGE widens to say plainly that this one is unverified.
const BILLED_BY = { OWNER: 'owner', VENDOR: 'vendor' };
const VENDOR_PAD = 0.15;

function estimateShipping({ lines = [], destState = '', pad = null, origin = ORIGIN, billedBy = BILLED_BY.OWNER } = {}) {
  const basis = [];
  const st = normalizeState(destState);
  const from = resolveOrigin(origin);
  const miles = st && from ? haversineMiles([from.lat, from.lon], STATE_CENTROIDS[st]) : null;
  const zone = st && from ? zoneForMiles(miles) : 5;
  if (st && from) basis.push(`${from.city} to ${st}: ~${Math.round(miles)} mi, zone ${zone}`);
  else if (!from) basis.push('No shipping origin — assuming zone 5 (mid-range). Set the printer on the line for a real number.');
  else basis.push('No ship-to state on the quote — assuming zone 5 (mid-range). Set the state for a real number.');

  // Per-line weights. "Shipping included" SKUs are carried but contribute
  // nothing to the freight base.
  let freightOz = 0;
  let hazmatTotal = 0;
  const perLine = lines.map((l, index) => {
    const product = (l && l.product) || {};
    const qty = Math.max(0, Number(l && l.qty) || 0);
    const w = effectiveUnitWeightOz(product);
    const included = shippingIncluded(product);
    const lineOz = included ? 0 : w.oz * qty;
    if (!included) freightOz += lineOz;

    const hz = hazmatFee(product, qty);
    if (hz) hazmatTotal += hz.fee;

    return {
      index,
      name: product.name || '',
      qty,
      unitWeightOz: w.oz,
      weightSource: w.source,
      weightBasis: w.basis,
      lineWeightLb: +(lineOz / OZ_PER_LB).toFixed(2),
      shippingIncluded: included,
      hazmat: hz ? hz.fee : 0,
      hazmatNote: hz ? hz.label : '',
      shipping: 0,   // filled in below once freight is allocated
    };
  });

  const includedCount = perLine.filter((p) => p.shippingIncluded).length;
  if (includedCount) basis.push(`${includedCount} line(s) marked "shipping included" by the vendor — excluded from freight`);

  const goodsLb = freightOz / OZ_PER_LB;
  const grossLb = goodsLb * PACKAGING_OVERHEAD;

  let freight = 0;
  let method = 'none';
  let cartons = 0;
  let billableLb = 0;

  if (grossLb > 0) {
    if (grossLb <= PARCEL_CEILING_LB) {
      method = 'parcel';
      cartons = Math.max(1, Math.ceil(grossLb / CARTON_MAX_LB));
      const perCartonLb = grossLb / cartons;
      // Dimensional weight only bites when a carton cubes out before it weighs
      // out — the light-and-bulky case (papers, cones, empty bags).
      const dimLb = CARTON_USABLE_IN3 / DIM_DIVISOR;
      const billablePerCarton = Math.max(perCartonLb, Math.min(dimLb, CARTON_MAX_LB));
      billableLb = +(billablePerCarton * cartons).toFixed(1);
      const r = PARCEL_RATES[zone];
      const transportation = cartons * (r.base + r.perLb * billablePerCarton);
      const withFuel = transportation * (1 + FUEL_SURCHARGE_PCT);
      freight = withFuel * (1 - ACCOUNT_INCENTIVE_PCT);
      basis.push(`${grossLb.toFixed(1)} lb gross in ${cartons} carton(s), billable ${billableLb} lb, zone ${zone} ground`);
      basis.push(billedBy === BILLED_BY.VENDOR
        ? `$${transportation.toFixed(2)} published + ${Math.round(FUEL_SURCHARGE_PCT * 100)}% fuel, then the vendor's rate assumed comparable to yours — they bill this, not UPS, so it is unverified`
        : `$${transportation.toFixed(2)} published + ${Math.round(FUEL_SURCHARGE_PCT * 100)}% fuel, less your ${Math.round(ACCOUNT_INCENTIVE_PCT * 100)}% UPS incentive`);
    } else {
      method = 'ltl';
      cartons = Math.ceil(grossLb / CARTON_MAX_LB);
      billableLb = +grossLb.toFixed(1);
      const cwt = LTL_CWT[zone];
      freight = Math.max(LTL_MIN_CHARGE, cwt * (grossLb / 100)) * LTL_FUEL_SURCHARGE;
      basis.push(`${grossLb.toFixed(1)} lb — over the ${PARCEL_CEILING_LB} lb parcel ceiling, priced as LTL freight at $${cwt}/cwt zone ${zone} +${Math.round((LTL_FUEL_SURCHARGE - 1) * 100)}% fuel`);
      basis.push('LTL is negotiated in practice — confirm with the vendor before committing on a large run.');
    }
  } else if (!includedCount) {
    basis.push('No shippable weight on these lines.');
  }

  // An explicit pad wins; otherwise it follows how certain the method is.
  const defaultPad = method === 'ltl' ? LTL_PAD
    : (billedBy === BILLED_BY.VENDOR ? VENDOR_PAD : DEFAULT_PAD);
  const padPct = pad === null || pad === undefined
    ? defaultPad
    : Math.max(0, Number(pad) || 0);
  const padded = freight * (1 + padPct);
  if (freight > 0 && padPct > 0) basis.push(`+${Math.round(padPct * 100)}% safety margin (catalog prices exclude freight)`);
  if (hazmatTotal > 0) basis.push(`+$${hazmatTotal.toFixed(2)} vendor hazmat fee (published, not estimated)`);

  const total = round2(padded + hazmatTotal);

  // Say it out loud rather than quietly quoting last year's rates.
  const ageDays = rateAgeDays();
  if (freight > 0 && ageDays > RATES_STALE_AFTER_DAYS) {
    basis.push(`Rate table last checked against a real invoice ${ageDays} days ago (${RATES_CALIBRATED_ON}). UPS raises rates each January and fuel floats weekly — worth re-checking against a recent bill.`);
  }

  // Allocate freight across the lines by their share of shippable weight, so
  // each quote line carries its own shippingCost. Hazmat rides on its own line.
  const base = perLine.reduce((s, p) => s + p.lineWeightLb, 0);
  perLine.forEach((p) => {
    const share = base > 0 ? p.lineWeightLb / base : 0;
    p.shipping = round2(padded * share + p.hazmat);
  });
  // Push any rounding drift onto the heaviest line so the parts equal the whole.
  reconcile(perLine, total);

  return {
    ok: true,
    origin: from || ORIGIN,
    destState: st,
    miles: miles === null ? null : Math.round(miles),
    zone,
    method,
    cartons,
    goodsLb: +goodsLb.toFixed(2),
    grossLb: +grossLb.toFixed(2),
    billableLb,
    freight: round2(freight),
    ratesCalibratedOn: RATES_CALIBRATED_ON,
    ratesAgeDays: ageDays,
    ratesStale: ageDays > RATES_STALE_AFTER_DAYS,
    pad: round2(padded - freight),
    hazmat: round2(hazmatTotal),
    total,
    // A believable spread around the point estimate, so the Studio can show a
    // range instead of implying false precision.
    billedBy,
    // A vendor-billed leg is genuinely unverified — their discount and their
    // markup are both unknown to us — so the band says so instead of implying
    // the same confidence as a leg billed to an account we can see.
    low: round2(total * (billedBy === BILLED_BY.VENDOR ? 0.55 : 0.75)),
    high: round2(total * (billedBy === BILLED_BY.VENDOR ? 1.60 : 1.35)),
    perLine,
    basis,
  };
}

// An origin may be the promo vendor (full coords) or just a printer's USPS
// state, which is all Printer.state carries. Both resolve to the same shape.
function resolveOrigin(origin) {
  if (!origin) return null;
  if (Number.isFinite(origin.lat) && Number.isFinite(origin.lon)) return origin;
  const st = normalizeState(origin.state || origin);
  if (!st) return null;
  const [lat, lon] = STATE_CENTROIDS[st];
  return { state: st, city: st, lat, lon };
}

// A blank tee with no recorded weight. The shared engine's UNKNOWN anchor is a
// PROMO default — 20 grams, a keychain — so an apparel line with no weight was
// being shipped at about a tenth of its real mass: 300 shirts came out as 14 lb
// in one carton instead of ~136 lb in four, and the freight with it. Apparel
// gets an apparel-shaped fallback, and the caller is told it was assumed.
const ASSUMED_GARMENT_OZ = 6.5;   // a mid-weight cotton tee, packed

/**
 * Freight for the APPAREL leg: the printer who decorated the job ships straight
 * to the client (docs/ECOSYSTEM.md step 9), billed third-party to the owner's
 * UPS account — the same account and the same rates as promo, so this is the
 * same engine with a different origin.
 *
 * Blanks moving supplier -> printer are NOT modeled: the owner gets those
 * freight-free, so adding a leg would invent a cost he does not pay.
 *
 * EACH LINE IS ITS OWN SHIPMENT. A quote's lines are mutually-exclusive
 * candidates — three brands at four run sizes is twelve lines, and the client
 * takes ONE cell. Packing all twelve into a single shipment sized the job at the
 * sum of every option nobody will order together, which threw off the carton
 * count, the billable weight and every line's share of the freight. A line asks
 * "what would it cost to ship THIS run?", so that is what each one is costed as.
 *
 * @param {Array}  lines        [{ weightOz, qty, label }] — weightOz per unit,
 *                              which quote lines carry as blankWeightOz.
 * @param {string} originState  the printer's USPS state (Printer.state).
 * @param {string} destState    the client's ship-to state.
 */
function estimateApparelShipping({ lines = [], originState = '', destState = '', pad = null } = {}) {
  const list = Array.isArray(lines) ? lines : [];
  const origin = originState ? { state: originState } : null;

  // Which garments we had to assume a weight for — by GARMENT, not by line. The
  // same blank appears once per run size, so listing every line repeated each
  // brand once per quantity column ("Gildan, Gildan, Gildan, Gildan").
  const assumed = [];
  const seenAssumed = new Set();

  const perLine = list.map((l) => {
    const known = Number(l && l.weightOz) > 0;
    const oz = known ? Number(l.weightOz) : ASSUMED_GARMENT_OZ;
    const label = (l && l.label) || 'Blank';
    if (!known) {
      const k = String(label).trim().toLowerCase();
      if (!seenAssumed.has(k)) { seenAssumed.add(k); assumed.push(label); }
    }
    const one = estimateShipping({
      lines: [{
        product: { name: label, unitWeightOz: oz, weightSource: 'catalog', category: '', description: '' },
        qty: Number(l && l.qty) || 0,
      }],
      destState,
      pad,
      origin,
      billedBy: BILLED_BY.OWNER,   // printers bill third-party to his UPS account
    });
    return {
      label,
      qty: Number(l && l.qty) || 0,
      weightOz: oz,
      assumedWeight: !known,
      shipping: one.ok ? one.total : 0,
      cartons: one.cartons || 0,
      grossLb: one.grossLb || 0,
      billableLb: one.billableLb || 0,
      method: one.method,
      zone: one.zone,
      miles: one.miles,
      raw: one,
    };
  });

  const priced = perLine.filter((r) => r.raw && r.raw.ok);
  if (!priced.length) return { ok: false, perLine, basis: ['Nothing to weigh yet — add a quantity.'] };

  // The HEADLINE is the biggest run, because that is the shipment most worth
  // sanity-checking, and every shipment fact (cartons, billable weight, parcel
  // vs freight, the rate table's age) then describes one real shipment rather
  // than a fictional combined one.
  const biggest = priced.reduce((a, b2) => (b2.raw.total > a.raw.total ? b2 : a), priced[0]);
  const amounts = priced.map((r) => r.shipping);

  const basis = [];
  const head = biggest.raw;
  if (head.miles != null) {
    // Said plainly: a state-to-state distance, not a route. It reads long
    // whenever the destination sits near the origin's border — the centre of
    // Michigan is 300 miles north of its southern cities.
    basis.push(`${originState || '?'} to ${destState || '?'}: ~${head.miles} mi between state centres, zone ${head.zone} (state-level — a destination near the border rates lower)`);
  } else if (head.zone) {
    basis.push(`No printer state — assuming zone ${head.zone}.`);
  }
  for (const r of priced) {
    basis.push(`${r.label} × ${r.qty}: ${r.grossLb.toFixed(1)} lb in ${r.cartons} carton(s)${r.method === 'ltl' ? ' — LTL freight' : ''} → $${r.shipping.toFixed(2)}`);
  }
  basis.push('Each run size is costed as its OWN shipment — the client takes one option, not all of them.');
  // Keep the engine's own explanation of the MONEY for the headline run — the
  // published rate, the fuel surcharge, the account incentive, the safety
  // margin. Dropping it left the owner with a number and no way to check it.
  for (const line of (head.basis || [])) {
    if (/fuel|incentive|safety margin|LTL|unverified/i.test(line)) basis.push(line);
  }
  if (assumed.length) {
    basis.push(`No garment weight on ${assumed.join(', ')} — assumed ${ASSUMED_GARMENT_OZ} oz each. Re-pick the blank from Find blanks to use the real weight.`);
  }
  if (head.ratesStale) basis.push(`Rate table last checked ${head.ratesCalibratedOn} — re-calibrate against a recent invoice.`);

  return {
    // Every shipment fact describes the BIGGEST run, which is a real shipment.
    ...head,
    perLine: perLine.map(({ raw, ...rest }) => rest),
    unweighed: assumed,
    // The runs are alternatives, so the honest headline is a spread from the
    // cheapest run to the dearest — never their sum.
    low: round2(Math.min(...amounts)),
    high: round2(Math.max(...amounts)),
    total: round2(biggest.shipping),
    basis,
  };
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function reconcile(perLine, total) {
  const sum = perLine.reduce((s, p) => s + p.shipping, 0);
  const drift = round2(total - sum);
  if (!drift || !perLine.length) return;
  let heaviest = perLine[0];
  for (const p of perLine) if (p.lineWeightLb > heaviest.lineWeightLb) heaviest = p;
  heaviest.shipping = round2(heaviest.shipping + drift);
}

module.exports = {
  ORIGIN, STATE_CENTROIDS, ZONE_BANDS, PARCEL_RATES, LTL_CWT,
  CARTON_MAX_LB, PARCEL_CEILING_LB, DEFAULT_PAD, LTL_PAD, ASSUMED_GARMENT_OZ,
  RATES_CALIBRATED_ON, RATES_STALE_AFTER_DAYS, rateAgeDays,
  BILLED_BY, VENDOR_PAD,
  FUEL_SURCHARGE_PCT, ACCOUNT_INCENTIVE_PCT,
  haversineMiles, zoneForMiles, normalizeState, resolveOrigin,
  estimateShipping, estimateApparelShipping,
};
