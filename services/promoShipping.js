// services/promoShipping.js
//
// Ballpark freight for a promo quote: Cannabis Promotions (St. Petersburg, FL)
// straight to the client. Promo goods are vendor-direct — the vendor
// manufactures, prints and ships them (docs/BUSINESS-MODEL.md #11) — so this
// models ONE leg, origin to destination.
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

// LTL freight, dollars per hundredweight, plus a fuel surcharge and a floor.
const LTL_CWT = { 2: 22, 3: 26, 4: 32, 5: 38, 6: 44, 7: 50, 8: 58 };
const LTL_MIN_CHARGE = 145;
const LTL_FUEL_SURCHARGE = 1.28;

const CARTON_MAX_LB = 40;         // what a picker will actually build
const CARTON_USABLE_IN3 = 2600;   // ~18x14x12 less dunnage
const DIM_DIVISOR = 139;          // standard domestic dimensional divisor
const PACKAGING_OVERHEAD = 1.08;  // box, void fill, tape
const PARCEL_CEILING_LB = 150;    // above this it moves as freight, not parcel

// Default safety margin. Promo freight is a cost the catalog price never
// covered, so the autofill leans high rather than leaving the owner short.
const DEFAULT_PAD = 0.15;

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
function estimateShipping({ lines = [], destState = '', pad = DEFAULT_PAD } = {}) {
  const basis = [];
  const st = normalizeState(destState);
  const miles = st ? haversineMiles([ORIGIN.lat, ORIGIN.lon], STATE_CENTROIDS[st]) : null;
  const zone = st ? zoneForMiles(miles) : 5;
  if (st) basis.push(`${ORIGIN.city} to ${st}: ~${Math.round(miles)} mi, zone ${zone}`);
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
      freight = cartons * (r.base + r.perLb * billablePerCarton);
      basis.push(`${grossLb.toFixed(1)} lb gross in ${cartons} carton(s), billable ${billableLb} lb, zone ${zone} ground`);
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

  const padPct = Math.max(0, Number(pad) || 0);
  const padded = freight * (1 + padPct);
  if (freight > 0 && padPct > 0) basis.push(`+${Math.round(padPct * 100)}% safety margin (catalog prices exclude freight)`);
  if (hazmatTotal > 0) basis.push(`+$${hazmatTotal.toFixed(2)} vendor hazmat fee (published, not estimated)`);

  const total = round2(padded + hazmatTotal);

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
    origin: ORIGIN,
    destState: st,
    miles: miles === null ? null : Math.round(miles),
    zone,
    method,
    cartons,
    goodsLb: +goodsLb.toFixed(2),
    grossLb: +grossLb.toFixed(2),
    billableLb,
    freight: round2(freight),
    pad: round2(padded - freight),
    hazmat: round2(hazmatTotal),
    total,
    // A believable spread around the point estimate, so the Studio can show a
    // range instead of implying false precision.
    low: round2(total * 0.75),
    high: round2(total * 1.35),
    perLine,
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
  CARTON_MAX_LB, PARCEL_CEILING_LB, DEFAULT_PAD,
  haversineMiles, zoneForMiles, normalizeState, estimateShipping,
};
