// utils/pricing.js
//
// Single source of truth for the public "Starting at $X" number shown on the
// products grid AND the product detail page. Keeping it in one pure module
// (no DB, no network, no heavy deps) means:
//   1. the grid card and the detail page can NEVER disagree on a price, and
//   2. the policy below is unit-testable on its own (see
//      controllers/__tests__/productPricing.test.js).
//
// ── Policy ───────────────────────────────────────────────────────────────────
// The price is derived from the REAL S&S Activewear blank cost (the lowest
// piecePrice across a style's SKUs), with a light teaser markup:
//
//     startingAt = max(MIN_DISPLAY_PRICE, round(blankCost * BLANK_MARKUP))
//
// BLANK_MARKUP is intentionally 1.4 — the same default the studio QuoteBuilder
// uses (see website-frontend QuoteBuilder.js) — so the public teaser sits
// "around the same as the blank cost" while still leaving headroom. It is a
// teaser: it covers the garment, NOT printing/setup, which are quoted per job
// ("Final price depends on quantity, colors, and print placement").
//
// To dial the displayed prices:
//   • Closer to raw blank cost  → lower BLANK_MARKUP toward 1.15 and/or
//                                 lower MIN_DISPLAY_PRICE.
//   • Toward all-in printed cost → raise BLANK_MARKUP / add a decoration base.
//
// CATEGORY_FALLBACK_PRICE is ONLY used when we don't yet have the real blank
// cost (cache still warming, or a style S&S won't return a price for). It is a
// per-category estimate so an un-priced hoodie never shows a tee's number. As
// soon as the real cost is known the derived price replaces it.

const BLANK_MARKUP = 1.4;        // teaser markup over the real S&S blank cost
const MIN_DISPLAY_PRICE = 5;     // absolute floor — a printed item under $5 reads as a bug

// Per-category "we don't know the real cost yet" estimate (was the old hard
// per-category floor that made every tee read $7 and every polo $14).
const CATEGORY_FALLBACK_PRICE = {
  'T-Shirts':    7,  'Long Sleeve': 9,  'Tanks':       7,
  'Polos':       14, 'Hoodies':     16, 'Zip-Ups':     20,
  'Crewnecks':   14, 'Jackets':     30, 'Pants':       14,
  'Shorts':      11, 'Hats':        8,
};
const DEFAULT_FALLBACK_PRICE = 8;

// blankCost: the real S&S blank cost (lowest piecePrice across the style's
// SKUs), or null/0 when unknown. category: one of the keys above.
function startingAt(blankCost, category) {
  if (typeof blankCost === 'number' && blankCost > 0) {
    return Math.max(MIN_DISPLAY_PRICE, Math.round(blankCost * BLANK_MARKUP));
  }
  // No real cost yet — fall back to a sensible per-category estimate.
  return CATEGORY_FALLBACK_PRICE[category] != null
    ? CATEGORY_FALLBACK_PRICE[category]
    : DEFAULT_FALLBACK_PRICE;
}

// Overlay a known real blank cost onto a style/product row (mutates + returns).
// No-op when the cost is unknown, so the row keeps its category estimate.
// Pure: given the same (row, cost) it always sets the same priceFrom.
function applyBlankCost(row, blankCost) {
  if (row && typeof blankCost === 'number' && blankCost > 0) {
    row.basePrice = blankCost;
    row.priceFrom = startingAt(blankCost, row.category);
  }
  return row;
}

module.exports = {
  BLANK_MARKUP,
  MIN_DISPLAY_PRICE,
  CATEGORY_FALLBACK_PRICE,
  DEFAULT_FALLBACK_PRICE,
  startingAt,
  applyBlankCost,
};
