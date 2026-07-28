// services/promoWeights.js
//
// Estimated shipping weight for a Cannabis Promotions catalog item.
//
// WHY THIS EXISTS: the vendor catalogs the owner was given carry price breaks
// but no weights and no carton packs, so a promo quote had no way to price
// freight. Shipping is a real cost the catalog's client price does NOT cover,
// so with no estimate it came silently out of the owner's catalog margin.
//
// THE MODEL. Not volume x material density — that badly overestimates hollow
// goods (a 3oz jar's bounding box says 0.43 lb of hemp plastic; the jar really
// weighs ~0.05 lb, because it is a shell, not a brick). Instead every category
// carries an ANCHOR: a real-world unit weight for a representative item at a
// known reference volume. An item scales off its anchor by the size parsed out
// of the catalog description:
//
//     grams = anchor.grams * (volume / anchor.volumeIn3) ** anchor.exp
//
// The exponent is sub-linear for hollow shells (wall thickness does not scale
// with capacity) and near-linear for solid goods.
//
// THE RULE THAT MAKES IT WORK: an anchor's reference volume MUST be measured by
// the same code path that measures a real item, or the ratio is meaningless. A
// first pass mixed bounding boxes, capacities and hand-guesses and produced a
// 1,555g silicone mat and a 4.7g Bic. So volume is now SHAPE-AWARE per category
// (cylinder / sheet / box / capacity), each anchor's volumeIn3 is that same
// formula applied to the representative item, and __tests__/promoWeights.test.js
// pins the representative items against known real-world weights.
//
// ACCURACY. A ballpark: roughly +/-30% per unit, better in aggregate because
// errors are uncorrelated across a mixed order. It autofills a number the owner
// reviews; it is not a carrier rate quote. Real vendor weights override it
// entirely — see `weightSource` on models/PromoProduct.js, where 'owner' and
// 'catalog' both beat 'estimated' and a re-seed never clobbers them.

const OZ_PER_GRAM = 0.0352739619;
const ML_TO_IN3 = 0.0610237;
const FLOZ_TO_IN3 = 1.80469;

// Shape drives how a description's numbers become a volume:
//   cylinder — round goods; a "D" measurement is a DIAMETER, not a depth
//   sheet    — flat goods; the unstated third axis is a real thickness, not a
//              proportion of the face (the bug that produced a 1.5kg dab mat)
//   box      — rectangular; three stated axes, or thickness for the third
//   capacity — containers, where stated ml/oz predicts shell weight best
//
// volumeIn3 is the representative item measured by THIS SAME rule, so the
// representative item always scores a ratio of exactly 1.0.
const ANCHORS = {
  // 4" dia glass ashtray, ~1" tall  -> pi*2^2*1
  'Ashtray':         { grams: 200, volumeIn3: 12.57, exp: 0.85, shape: 'cylinder', thickIn: 1.0 },
  // mylar eighth-oz barrier bag, 3 x 4.5 x 0.1
  'Bag':             { grams: 3,   volumeIn3: 1.35,  exp: 0.75, shape: 'sheet',    thickIn: 0.1 },
  // 5ml glass concentrate jar + lid
  'Concentrate Jar': { grams: 20,  volumeIn3: 0.305, exp: 0.65, shape: 'capacity' },
  // 12 x 8.5 silicone mat, 0.08 thick
  'Dab Mat':         { grams: 90,  volumeIn3: 8.16,  exp: 0.95, shape: 'sheet',    thickIn: 0.08 },
  'Dab Tool':        { grams: 10,  volumeIn3: 0.60,  exp: 0.90, shape: 'box',      thickIn: 0.2,   refLenIn: 2.5 },
  // .37 dia x 1.37 glass tip
  'Glass Tip':       { grams: 2,   volumeIn3: 0.147, exp: 0.85, shape: 'cylinder', thickIn: 0.3,   refLenIn: 1.37 },
  // 40mm 4-piece metal: 1.5" dia x 1.3" H
  'Grinder':         { grams: 60,  volumeIn3: 2.30,  exp: 0.95, shape: 'cylinder', thickIn: 1.0 },
  // 3 fl oz jar
  'Jar':             { grams: 25,  volumeIn3: 5.41,  exp: 0.65, shape: 'capacity' },
  // Bic: 1"W x 3"H x ~0.5 thick
  'Lighter':         { grams: 11,  volumeIn3: 1.50,  exp: 0.80, shape: 'sheet',    thickIn: 0.5 },
  'Match Box':       { grams: 5,   volumeIn3: 1.16,  exp: 0.85, shape: 'box',      thickIn: 0.375 },
  // 4" glass chillum, ~0.5" bore
  'One Hitter':      { grams: 15,  volumeIn3: 0.785, exp: 0.85, shape: 'cylinder', thickIn: 0.5,   refLenIn: 4.0 },
  // 116mm plastic tube, ~0.6" dia
  'Pre-Roll Tube':   { grams: 4,   volumeIn3: 1.29,  exp: 0.70, shape: 'cylinder', thickIn: 0.6,   refLenIn: 4.567, preferMm: true },
  // ONE cone; the 3-pack math is applied separately via unitsPerPricedUnit
  'Pre-Rolled Cone': { grams: 1,   volumeIn3: 0.50,  exp: 0.80, shape: 'cylinder', thickIn: 0.5,   refLenIn: 3.27,  preferMm: true },
  // 1 1/4 booklet + rounded box: 3.07 x 1.02 x ~0.5
  'Rolling Paper':   { grams: 7,   volumeIn3: 1.57,  exp: 0.85, shape: 'sheet',    thickIn: 0.5,   pkgIncluded: true },
  // 15ml glass tincture + custom box
  'Tincture Bottle': { grams: 45,  volumeIn3: 0.915, exp: 0.65, shape: 'capacity', pkgIncluded: true },
  // medium hemp-plastic tray 10.5 x 6 x ~0.55
  'Tray':            { grams: 110, volumeIn3: 34.65, exp: 0.85, shape: 'sheet',    thickIn: 0.55 },
  // 350mAh battery: .4" dia x 3.45"
  'Vape':            { grams: 25,  volumeIn3: 0.434, exp: 0.80, shape: 'cylinder', thickIn: 0.4 },
  UNKNOWN:           { grams: 20,  volumeIn3: 3.00,  exp: 0.80, shape: 'box',      thickIn: 0.5 },
};

// ── Curated per-item weights ─────────────────────────────────────────────────
// The anchor model reasons about SIZE, not FORM, so it misses items whose shape
// or material differs from their category's representative product: a flat
// "grinder card" in a category anchored on round metal grinders, a metal tin
// tray against a hemp-plastic anchor, a 35" polyester lanyard read as a solid
// cylinder, and the Bag category being bimodal (mylar pouches vs hard cases
// with combination locks). Ten items is small enough to simply measure and pin,
// which is more honest than bending the heuristics until they fit.
// Grams, real-world. These behave exactly like a vendor weight: they win.
const ITEM_OVERRIDES = {
  'Custom Grinder Card': 55,                                   // flat stainless card, not a round grinder
  'Plastic Grinder': 30,                                       // plastic against a metal anchor
  'Vape Lanyard with Silicone Ring': 15,                       // 35" strap, not a 35" rod
  'Carbon Carrying Case with Combination Lock': 150,           // hard case + lock
  'Carbon Stash Bag with Combination Lock': 120,               // the lock alone outweighs the pouch model
  'Carbon Waist Pack': 200,
  'Stash Backpack': 550,
  'Glass Rolling Tray - Small': 400,                           // glass, not hemp plastic
  'Full Custom Metal Rolling Tray - Medium': 200,
  'Full Custom Metal Rolling Tray - Small': 130,
  'Quick Print Metal Rolling Tray - Medium': 200,
  'Quick Print Metal Rolling Tray - Small': 130,
  'Quick Print Metal Rolling Tray w/ Magnetic Lid - Medium': 300,
  'Quick Print Metal Rolling Tray w/ Magnetic Lid - Small': 200,
};

// Some overseas SKUs state "OVERSEAS production, shipping included" — the
// vendor's price already covers freight, so estimating any on top would
// overcharge the client. Honor the catalog rather than the model.
function shippingIncluded(product) {
  const d = `${(product && product.description) || ''} ${((product && product.flags) || []).join(' ')}`;
  return /shipping\s+included/i.test(d);
}

// Fraction-aware inch value: 2-1/4, 3/8, .86, 3.07
function inchValue(raw) {
  const s = String(raw || '').trim();
  let m = s.match(/^(\d+)[-\s]+(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) + Number(m[2]) / Number(m[3]);
  m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return Number(m[1]) / Number(m[2]);
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Pull labelled inch measurements out of a catalog description. Handles the
// shapes the scrape actually produced: `8"W x 4"H, 3" depth`,
// `1.52"H x 2.88" diameter`, `2-1/4" x 1-3/8" x 3/8"`, `.4"W x 3.45"H`, `116mm`.
// A description with two measurement groups (the papers: "Booklet 3.07"W x
// 1.02"H, paper 3.07"W x 1.7"H") keeps the FIRST group — the shipped article.
function parseDims(text) {
  const s = String(text || '');
  const plain = [];
  let diameter = null;
  let depth = null;

  // The `\b` binds to the LABEL, not to the optional group. Written as
  // `(...)?\b` it required a word boundary after a bare measurement, so
  // `3.75" x 1.57";` silently dropped the second number (`"` -> `;` is not a
  // boundary) and the Dabit card came out 30x heavy.
  const re = /(\d*\.?\d+(?:[-\s]+\d+\/\d+)?|\d+\/\d+)\s*"\s*(?:(W|H|D|L|depth|diameter|dia)\b)?/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    const v = inchValue(m[1]);
    if (v === null || v <= 0) continue;
    const label = String(m[2] || '').toLowerCase();
    if (label.startsWith('dia') || label === 'd') {
      // "D" in this catalog means diameter on round goods (grinders are
      // listed 1.5"D x 1.3"H = 40mm across, 33mm tall).
      if (diameter === null) diameter = v;
    } else if (label === 'depth') {
      if (depth === null) depth = v;
    } else {
      plain.push(v);
    }
  }

  // Always resolve a millimetre length when one is present — the cones state the
  // article in mm and the display case in inches, so both have to be available
  // for `preferMm` to pick the right one.
  const mm = s.match(/(\d+(?:\.\d+)?)\s*mm\b/);
  const mmLenIn = mm ? Number(mm[1]) / 25.4 : null;

  if (plain.length === 0 && diameter === null && depth === null) {
    if (mmLenIn) return { faces: [], diameter: null, depth: null, mmLenIn, longestIn: mmLenIn, from: 'mm' };
    return { faces: [], diameter: null, depth: null, mmLenIn: null, longestIn: null, from: null };
  }

  const faces = plain.slice(0, 2);            // first measurement group only
  const all = faces.concat(diameter ? [diameter] : [], depth ? [depth] : []);
  return {
    faces, diameter, depth, mmLenIn,
    longestIn: all.length ? Math.max(...all) : null,
    from: 'inches',
  };
}

function parseCapacityIn3(text) {
  const s = String(text || '');
  let m = s.match(/(\d+(?:\.\d+)?)\s*ml\b/i);
  if (m) return Number(m[1]) * ML_TO_IN3;
  m = s.match(/(\d+(?:\.\d+)?)\s*oz\b/i);
  if (m) return Number(m[1]) * FLOZ_TO_IN3;
  return null;
}

// Volume by the category's shape rule — the same function used to derive every
// anchor's reference volume, which is what keeps the ratio meaningful.
function volumeFor(anchor, dims, capIn3) {
  if (anchor.shape === 'capacity' && capIn3 !== null) return { vol: capIn3, from: 'capacity' };

  // Some categories state the article in mm and the PACKAGING in inches (the
  // cones list "83mm, 98mm & 109mm; 4"W x 3"H" — the inches are the display
  // case). Measuring the case as if it were the cone made one cone 56x too big.
  if (anchor.preferMm && dims.mmLenIn) {
    const refLen = anchor.refLenIn || Math.cbrt(anchor.volumeIn3);
    return { vol: anchor.volumeIn3 * (dims.mmLenIn / refLen) ** 1.5, from: 'mm length' };
  }

  if (anchor.shape === 'cylinder') {
    const d = dims.diameter !== null ? dims.diameter : (dims.faces.length >= 2 ? Math.min(...dims.faces) : anchor.thickIn);
    // Height comes from an unlabelled face, else a bare mm length. It must NOT
    // fall back to `longestIn` when that value IS the diameter ("4" diameter;
    // glass") — squaring the diameter into the height tripled the ashtray.
    const h = dims.faces.length
      ? Math.max(...dims.faces)
      : (dims.diameter === null && dims.longestIn ? dims.longestIn : anchor.thickIn);
    if (d > 0 && h > 0) return { vol: Math.PI * (d / 2) ** 2 * h, from: 'cylinder' };
  }

  if (anchor.shape === 'sheet') {
    const t = dims.depth !== null ? dims.depth : anchor.thickIn;
    if (dims.faces.length >= 2) return { vol: dims.faces[0] * dims.faces[1] * t, from: 'sheet' };
    // A ROUND sheet ("8" diameter" circle dab mat) is still a sheet: area x
    // thickness. Falling through to the length path treated it as a solid and
    // clamped it at 4kg.
    if (dims.diameter !== null) return { vol: Math.PI * (dims.diameter / 2) ** 2 * t, from: 'round sheet' };
  }

  if (anchor.shape === 'box') {
    if (dims.faces.length >= 2) {
      const t = dims.depth !== null ? dims.depth : anchor.thickIn;
      return { vol: dims.faces[0] * dims.faces[1] * t, from: 'box' };
    }
  }

  // Only a length is known. Cubic (isotropic) scaling is wrong here: these are
  // elongated articles — a longer dab tool or chillum grows mostly along one
  // axis — and cubing off a cube-root "reference length" made a 4" dab tool
  // 668g. Scale gently off an explicit reference length instead.
  if (dims.longestIn) {
    const refLen = anchor.refLenIn || Math.cbrt(anchor.volumeIn3);
    return { vol: anchor.volumeIn3 * (dims.longestIn / refLen) ** 1.5, from: 'length' };
  }
  if (capIn3 !== null) return { vol: capIn3, from: 'capacity' };
  return { vol: null, from: null };
}

// How many physical pieces make up ONE priced unit. The cones are sold and
// priced in 3-packs with a display case — the scrape recorded that in `flags`,
// and missing it would understate that line's freight threefold.
function unitsPerPricedUnit(product) {
  const hay = [(product && product.name) || '', ((product && product.flags) || []).join(' ')].join(' ');
  const m = hay.match(/(\d+)\s*-?\s*pack/i);
  if (m) {
    const n = Number(m[1]);
    if (n > 0 && n <= 50) return n;
  }
  return 1;
}

// Packaging that ships WITH each priced unit, stated in the description.
// Skipped when the category anchor already bakes its box into the stated grams
// (the papers anchor IS "booklet + rounded box"), or the box gets counted twice.
function packagingGrams(product, anchor) {
  if (anchor && anchor.pkgIncluded) return 0;
  const d = `${(product && product.description) || ''} ${(product && product.name) || ''}`;
  let g = 0;
  if (/display case/i.test(d)) g += 12;
  if (/custom box|with box|\+ box|rounded box/i.test(d)) g += 6;
  return g;
}

/**
 * Estimated shipping weight of ONE priced unit.
 * @returns {{oz:number, grams:number, source:string, basis:string}}
 *          `basis` is human-readable so the Studio can explain the number.
 */
function estimateUnitWeightOz(product) {
  const p = product || {};
  const category = p.category || '';
  const anchor = ANCHORS[category] || ANCHORS.UNKNOWN;
  const text = `${p.description || ''} ${p.name || ''}`;

  const pinned = ITEM_OVERRIDES[p.name];
  if (pinned > 0) {
    const per0 = unitsPerPricedUnit(p);
    const g0 = pinned * per0;
    return {
      oz: Math.round(g0 * OZ_PER_GRAM * 1000) / 1000,
      grams: Math.round(g0 * 10) / 10,
      source: 'curated',
      basis: `curated weight ${pinned}g${per0 > 1 ? ` x${per0}/pack` : ''}`,
    };
  }

  const dims = parseDims(text);
  const capIn3 = parseCapacityIn3(text);
  const { vol, from } = volumeFor(anchor, dims, capIn3);

  let grams;
  let basis;
  if (vol && vol > 0) {
    const ratio = vol / anchor.volumeIn3;
    grams = anchor.grams * Math.pow(ratio, anchor.exp);
    basis = `${category || 'unknown'} anchor ${anchor.grams}g x ${ratio.toFixed(2)} (${from})`;
  } else {
    grams = anchor.grams;
    basis = `${category || 'unknown'} category default (no size in description)`;
  }

  const per = unitsPerPricedUnit(p);
  const pkg = packagingGrams(p, anchor);
  if (per > 1) basis += `; x${per}/pack`;
  if (pkg > 0) basis += `; +${pkg}g packaging`;

  // Clamp to a physically sane band so a mis-parse can never put an absurd
  // freight number on a client quote.
  const total = Math.min(Math.max(grams * per + pkg, 0.2), 4000);
  return {
    oz: Math.round(total * OZ_PER_GRAM * 1000) / 1000,
    grams: Math.round(total * 10) / 10,
    source: 'estimated',
    basis,
  };
}

/** The weight to USE: a vendor- or owner-supplied weight always beats the estimate. */
function effectiveUnitWeightOz(product) {
  const p = product || {};
  const stored = Number(p.unitWeightOz);
  if (stored > 0 && (p.weightSource === 'owner' || p.weightSource === 'catalog')) {
    return { oz: stored, grams: Math.round(stored / OZ_PER_GRAM * 10) / 10, source: p.weightSource, basis: `${p.weightSource}-supplied weight` };
  }
  if (stored > 0 && p.weightSource === 'estimated') {
    return { oz: stored, grams: Math.round(stored / OZ_PER_GRAM * 10) / 10, source: 'estimated', basis: 'stored estimate' };
  }
  return estimateUnitWeightOz(p);
}

// Stated vendor hazmat fees (butane lighters). These are REAL published charges
// carried in the catalog flags, so they are added verbatim on top of the freight
// estimate rather than folded into it.
//   "Hazmat ship fee: $25 (net) per 500 units — add to quote"
//   "Hazmat ship fee: $25 (net) per 240-480 units — add to quote"
function hazmatFee(product, qty) {
  const flags = (product && product.flags) || [];
  for (const f of flags) {
    const m = String(f).match(/hazmat[^$]*\$\s*(\d+(?:\.\d+)?)[^\d]*per\s*(\d+)(?:\s*-\s*(\d+))?\s*units/i);
    if (!m) continue;
    const perBlock = Number(m[1]);
    // A stated range ("per 240-480 units") bills against the SMALLER block —
    // the conservative read, so a quote is never short the vendor's charge.
    const block = Number(m[2]);
    if (perBlock > 0 && block > 0) {
      const blocks = Math.ceil(Math.max(0, Number(qty) || 0) / block);
      return { fee: +(perBlock * blocks).toFixed(2), blocks, block, perBlock, label: String(f) };
    }
  }
  return null;
}

module.exports = {
  ANCHORS, OZ_PER_GRAM, ITEM_OVERRIDES, shippingIncluded,
  parseDims, parseCapacityIn3, volumeFor,
  unitsPerPricedUnit, packagingGrams,
  estimateUnitWeightOz, effectiveUnitWeightOz, hazmatFee,
};
