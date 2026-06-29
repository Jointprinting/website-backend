// controllers/__tests__/productPricing.test.js
//
// Locks in the fix for the "every tee is $7, every polo is $14" bug: the public
// "Starting at $X" must derive from the REAL S&S blank cost so prices vary per
// style, and must fall back to a per-category estimate only when the cost isn't
// known yet. Pure logic — no DB, no network.
//
//   node --test controllers/__tests__/productPricing.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BLANK_MARKUP,
  MIN_DISPLAY_PRICE,
  CATEGORY_FALLBACK_PRICE,
  startingAt,
  applyBlankCost,
} = require('../../utils/pricing');

// ── startingAt: real cost in → cost-derived price out ────────────────────────
test('startingAt derives from the real blank cost (markup applied, rounded)', () => {
  // Comfort Colors-ish premium tee: $6 blank → round(6 * 1.4) = 8, above floor.
  assert.equal(startingAt(6, 'T-Shirts'), Math.round(6 * BLANK_MARKUP));
  // Polo: $11 blank → 15, well above the old flat $14 estimate.
  assert.equal(startingAt(11, 'Polos'), Math.round(11 * BLANK_MARKUP));
  // Hoodie: $13 blank → 18.
  assert.equal(startingAt(13, 'Hoodies'), Math.round(13 * BLANK_MARKUP));
});

test('startingAt never dips below the absolute minimum display price', () => {
  // Cheap Gildan tee: $2.50 blank → round(3.5) = 4, clamped up to the floor.
  assert.equal(startingAt(2.5, 'T-Shirts'), MIN_DISPLAY_PRICE);
  assert.ok(startingAt(0.5, 'Tanks') >= MIN_DISPLAY_PRICE);
});

// ── startingAt: unknown cost → per-category estimate (NOT a flat number) ──────
test('startingAt falls back to the per-category estimate when cost is unknown', () => {
  assert.equal(startingAt(null, 'T-Shirts'), CATEGORY_FALLBACK_PRICE['T-Shirts']);
  assert.equal(startingAt(0, 'Polos'), CATEGORY_FALLBACK_PRICE['Polos']);
  assert.equal(startingAt(undefined, 'Hoodies'), CATEGORY_FALLBACK_PRICE['Hoodies']);
  // Unknown category → safe default, never a crash.
  assert.equal(typeof startingAt(null, 'Promo'), 'number');
});

// ── The actual bug: prices must VARY across styles in the same category ───────
test('two same-category styles with different blank costs get different prices', () => {
  const basicTee   = { style: '5000', styleID: 1, category: 'T-Shirts', priceFrom: startingAt(null, 'T-Shirts') };
  const premiumTee = { style: '1717', styleID: 2, category: 'T-Shirts', priceFrom: startingAt(null, 'T-Shirts') };

  // Before enrichment both show the identical category estimate — the bug.
  assert.equal(basicTee.priceFrom, premiumTee.priceFrom);

  applyBlankCost(basicTee, 2.5);    // cheap blank
  applyBlankCost(premiumTee, 6.0);  // premium blank

  // After enrichment they diverge and track the real cost.
  assert.notEqual(basicTee.priceFrom, premiumTee.priceFrom);
  assert.equal(premiumTee.priceFrom, Math.round(6 * BLANK_MARKUP));
  assert.equal(basicTee.basePrice, 2.5);
  assert.equal(premiumTee.basePrice, 6.0);
});

test('applyBlankCost is a no-op when the cost is unknown (keeps the estimate)', () => {
  const row = { category: 'Polos', priceFrom: startingAt(null, 'Polos') };
  applyBlankCost(row, null);
  assert.equal(row.priceFrom, CATEGORY_FALLBACK_PRICE['Polos']);
  assert.equal(row.basePrice, undefined);
  applyBlankCost(row, 0);
  assert.equal(row.priceFrom, CATEGORY_FALLBACK_PRICE['Polos']);
});
