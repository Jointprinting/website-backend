// services/blankOptions.js
//
// Tiered blank options for the Quoter, priced off live S&S Activewear data.
//
// WHY THIS EXISTS: quoting apparel meant leaving the Studio, asking an LLM for a
// budget / mid / premium tee, hand-averaging the sizes people actually order,
// and pasting the number back in as blankCost. Every step of that is data S&S
// already returns through the client in controllers/product.js. This turns it
// into one call.
//
// THREE RULES THAT COME FROM HOW THE OWNER ACTUALLY QUOTES:
//
//  1. QUOTE OFF LIST, NOT OFF HIS PRICE. When S&S runs a promo, the owner keeps
//     that spread — so the quoted blank cost is the LIST piece price, never
//     `customerPrice` / `salePrice`. Both are still reported so the Studio can
//     show what he is pocketing, but only list feeds the quote.
//
//  2. AVERAGE ACROSS THE SIZES THAT ACTUALLY SELL. docs/ECOSYSTEM.md: "Blank
//     pricing is averaged across all sizes -> one price per item; there is no
//     per-size upcharge." XS-2XL is the window the owner uses, and 2XL usually
//     prices higher, so a flat average is what keeps one honest number per item.
//
//  3. NEVER QUOTE SOMETHING THAT IS NOT THERE. A blank with no stock in the
//     client's color is not an option, so availability is part of the answer,
//     not a footnote.
//
// FIELD READING IS DEFENSIVE ON PURPOSE. Only some S&S SKU fields are proven in
// this codebase (piecePrice / sizeName / sizeOrder / colorName — see
// summarizeSsStyle). Weight and inventory field names are read through a
// tolerant picker in the same spirit as extractAlphaBroderMinPrice, so a naming
// difference degrades one field instead of failing the request. Anything
// unavailable comes back null and the caller shows "unknown" rather than a
// wrong number.

// The sizes that make up the bulk of orders. 2XL is included deliberately: it
// prices higher, and averaging it in is what stops a 2XL-heavy run from eating
// the margin.
const DEFAULT_SIZE_WINDOW = ['XS', 'S', 'M', 'L', 'XL', '2XL'];

// Tier names in the order the owner asks for them.
const TIERS = ['budget', 'mid', 'premium'];

const OZ_PER_LB = 16;

// ── Tolerant field reads ─────────────────────────────────────────────────────
function readNum(obj, fields) {
  if (!obj || typeof obj !== 'object') return null;
  for (const f of fields) {
    const v = parseFloat(obj[f]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

// LIST price — what the quote is built on (rule 1).
const LIST_PRICE_FIELDS = ['piecePrice', 'pieceprice', 'basePricePerPiece', 'basePrice', 'price'];
// What the owner actually pays. Reported for reference only; never quoted.
const OWNER_PRICE_FIELDS = ['customerPrice', 'yourPrice', 'salePrice', 'saleprice'];
// Per-unit shipping weight. Feeds apparel freight, so it is stored per style.
const WEIGHT_LB_FIELDS = ['weight', 'unitWeight', 'shippingWeight', 'wt'];

function listPriceOf(sku) { return readNum(sku, LIST_PRICE_FIELDS); }
function ownerPriceOf(sku) { return readNum(sku, OWNER_PRICE_FIELDS); }

// Total on-hand for a SKU. S&S reports either a flat qty or a per-warehouse
// breakdown; sum the warehouses when present since any of them can fulfil.
function qtyOf(sku) {
  if (!sku || typeof sku !== 'object') return null;
  const flat = readNum(sku, ['qty', 'quantity', 'totalQty', 'inventory']);
  const houses = sku.warehouses || sku.Warehouses;
  if (Array.isArray(houses) && houses.length) {
    let sum = 0;
    let saw = false;
    for (const w of houses) {
      const q = readNum(w, ['qty', 'quantity']);
      if (q !== null) { sum += q; saw = true; }
    }
    if (saw) return sum;
  }
  return flat;
}

const norm = (s) => String(s || '').trim().toUpperCase();

// S&S writes 2XL as "2XL", "XXL", or "2X" depending on the brand. Fold them so
// a size window means the same thing across every vendor.
function canonicalSize(name) {
  const s = norm(name).replace(/\s+/g, '');
  const map = {
    XXS: 'XS', XS: 'XS', S: 'S', SM: 'S', M: 'M', MED: 'M', L: 'L', LG: 'L',
    XL: 'XL', '1XL': 'XL',
    XXL: '2XL', '2X': '2XL', '2XL': '2XL',
    XXXL: '3XL', '3X': '3XL', '3XL': '3XL',
    XXXXL: '4XL', '4X': '4XL', '4XL': '4XL',
  };
  return map[s] || s;
}

/**
 * Average LIST price across a size window, one SKU per size.
 *
 * Averaging over raw SKU rows would weight by however many colors a size
 * happens to come in, which silently skews the number toward whatever the
 * vendor stocks widely. So collapse to one price per size first (the cheapest
 * row for that size), then average the sizes.
 *
 * @returns {{avg:number|null, perSize:Object, covered:string[], missing:string[]}}
 */
function averageListPrice(skus, { sizeWindow = DEFAULT_SIZE_WINDOW, color = '' } = {}) {
  const want = new Set(sizeWindow.map(canonicalSize));
  const wantColor = norm(color);
  const bySize = new Map();

  for (const sku of skus || []) {
    const size = canonicalSize(sku && sku.sizeName);
    if (!want.has(size)) continue;
    if (wantColor && norm(sku.colorName) !== wantColor) continue;
    const p = listPriceOf(sku);
    if (p === null) continue;
    const prev = bySize.get(size);
    if (prev === undefined || p < prev) bySize.set(size, p);
  }

  const covered = sizeWindow.map(canonicalSize).filter((s) => bySize.has(s));
  const missing = sizeWindow.map(canonicalSize).filter((s) => !bySize.has(s));
  if (!covered.length) return { avg: null, perSize: {}, covered: [], missing };

  const sum = covered.reduce((s, k) => s + bySize.get(k), 0);
  const perSize = {};
  covered.forEach((k) => { perSize[k] = round2(bySize.get(k)); });
  return { avg: round2(sum / covered.length), perSize, covered, missing };
}

/**
 * Stock for a color across the size window.
 * `ok` is false when any size in the window has nothing on hand — a run needs
 * every size it quotes, so a partial is a problem worth surfacing.
 */
function stockForColor(skus, { color = '', sizeWindow = DEFAULT_SIZE_WINDOW } = {}) {
  const want = sizeWindow.map(canonicalSize);
  const wantColor = norm(color);
  const bySize = {};
  let known = false;

  for (const sku of skus || []) {
    const size = canonicalSize(sku && sku.sizeName);
    if (!want.includes(size)) continue;
    if (wantColor && norm(sku.colorName) !== wantColor) continue;
    const q = qtyOf(sku);
    if (q === null) continue;
    known = true;
    bySize[size] = (bySize[size] || 0) + q;
  }

  // S&S did not give us inventory we can read — say so rather than implying
  // a blank is out of stock.
  if (!known) return { known: false, ok: null, total: null, bySize: {}, shortSizes: [] };

  const shortSizes = want.filter((s) => !(bySize[s] > 0));
  const total = Object.values(bySize).reduce((a, b) => a + b, 0);
  return { known: true, ok: shortSizes.length === 0, total, bySize, shortSizes };
}

/** Per-unit shipping weight in ounces — what apparel freight will need. */
function unitWeightOz(skus, { sizeWindow = DEFAULT_SIZE_WINDOW } = {}) {
  const want = new Set(sizeWindow.map(canonicalSize));
  const vals = [];
  for (const sku of skus || []) {
    if (!want.has(canonicalSize(sku && sku.sizeName))) continue;
    const lb = readNum(sku, WEIGHT_LB_FIELDS);
    if (lb !== null) vals.push(lb * OZ_PER_LB);
  }
  if (!vals.length) return null;
  // Median: one mis-keyed row can't drag the figure the way a mean would.
  vals.sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  const oz = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  return Math.round(oz * 100) / 100;
}

/** Is S&S running a promo on this style, and what is the owner's spread? */
function saleSpread(skus, listAvg) {
  const owner = [];
  for (const sku of skus || []) {
    const p = ownerPriceOf(sku);
    if (p !== null) owner.push(p);
  }
  if (!owner.length || listAvg === null) return { known: false, ownerAvg: null, spread: null };
  const ownerAvg = round2(owner.reduce((a, b) => a + b, 0) / owner.length);
  return {
    known: true,
    ownerAvg,
    // Positive = the owner is buying under list, and that difference is his.
    spread: round2(listAvg - ownerAvg),
  };
}

/**
 * Split priced candidates into budget / mid / premium.
 *
 * Terciles of the actual candidate set, not fixed dollar bands: "budget" means
 * cheap *relative to what is available for this garment type*, and a fixed band
 * would put every hoodie in "premium" and every tee in "budget".
 */
function assignTiers(candidates) {
  const priced = candidates.filter((c) => typeof c.blankCost === 'number' && c.blankCost > 0);
  if (!priced.length) return [];
  const sorted = [...priced].sort((a, b) => a.blankCost - b.blankCost);
  if (sorted.length <= TIERS.length) {
    return sorted.map((c, i) => ({ ...c, tier: TIERS[Math.min(i, TIERS.length - 1)] }));
  }
  // Two boundaries computed independently. Deriving the second as `cut * 2`
  // starves the top tier on small sets — four candidates gave budget 2, mid 2
  // and premium NOTHING, so the owner lost his premium option exactly when the
  // garment type had few choices.
  const n = sorted.length;
  const b1 = Math.ceil(n / 3);
  const b2 = Math.ceil((n * 2) / 3);
  return sorted.map((c, i) => ({
    ...c,
    tier: i < b1 ? 'budget' : i < b2 ? 'mid' : 'premium',
  }));
}

/** One representative pick per tier — the cheapest in-stock option in each. */
function pickPerTier(tiered) {
  const out = {};
  for (const tier of TIERS) {
    const inTier = tiered.filter((c) => c.tier === tier);
    if (!inTier.length) { out[tier] = null; continue; }
    // Prefer something actually orderable; fall back rather than return nothing.
    const stocked = inTier.filter((c) => c.stock && c.stock.ok !== false);
    out[tier] = (stocked.length ? stocked : inTier)[0];
  }
  return out;
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

/**
 * Build the option set for one style's SKU rows. Pure — no network — so the
 * controller owns fetching/caching and this stays unit-testable.
 */
function summarizeBlank(style, skus, { sizeWindow = DEFAULT_SIZE_WINDOW, color = '' } = {}) {
  const price = averageListPrice(skus, { sizeWindow, color });
  const stock = stockForColor(skus, { sizeWindow, color });
  const weightOz = unitWeightOz(skus, { sizeWindow });
  const sale = saleSpread(skus, price.avg);
  const first = (skus && skus[0]) || {};

  return {
    styleID:   style && style.styleID != null ? style.styleID : (first.styleID ?? null),
    style:     (style && (style.style || style.styleName)) || first.styleName || '',
    brand:     (style && style.brand) || first.brandName || '',
    title:     (style && style.title) || first.title || '',
    // The number that lands in the quote line: LIST, averaged over the window.
    blankCost: price.avg,
    perSize:   price.perSize,
    sizesPriced: price.covered,
    sizesMissing: price.missing,
    unitWeightOz: weightOz,
    stock,
    sale,
    color: color || null,
    sizeWindow: sizeWindow.map(canonicalSize),
  };
}

module.exports = {
  DEFAULT_SIZE_WINDOW, TIERS,
  canonicalSize, listPriceOf, ownerPriceOf, qtyOf,
  averageListPrice, stockForColor, unitWeightOz, saleSpread,
  assignTiers, pickPerTier, summarizeBlank,
};
