// controllers/__tests__/catalogOrder.test.js
//
// The "front page someone sees clicking Products must not be majority the same
// number" check. The catalog is popularity-sorted and the popular styles are
// almost all cheap tees, so the unfiltered first page used to be a wall of
// near-identically-priced shirts. diversifyByCategory round-robins across
// garment types so the first page spans categories (and therefore prices).
//
//   node --test controllers/__tests__/catalogOrder.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { diversifyByCategory } = require('../../utils/catalogOrder');

// Build a realistic popularity-sorted catalog: lots of tees up front (as today),
// then sweats, hoodies, polos, etc. priceFrom mirrors the real spread (cheap
// tees floor at $5; pricier categories climb).
function sampleCatalog() {
  const tees   = Array.from({ length: 30 }, (_, i) => ({ style: `tee${i}`,   category: 'T-Shirts', priceFrom: 5 }));
  const ls     = Array.from({ length: 8 },  (_, i) => ({ style: `ls${i}`,    category: 'Long Sleeve', priceFrom: 7 }));
  const crews  = Array.from({ length: 8 },  (_, i) => ({ style: `crew${i}`,  category: 'Crewnecks', priceFrom: 14 }));
  const hoods  = Array.from({ length: 8 },  (_, i) => ({ style: `hood${i}`,  category: 'Hoodies',   priceFrom: 18 }));
  const polos  = Array.from({ length: 6 },  (_, i) => ({ style: `polo${i}`,  category: 'Polos',     priceFrom: 15 }));
  const tanks  = Array.from({ length: 6 },  (_, i) => ({ style: `tank${i}`,  category: 'Tanks',     priceFrom: 5 }));
  const hats   = Array.from({ length: 4 },  (_, i) => ({ style: `hat${i}`,   category: 'Hats',      priceFrom: 8 }));
  // Incoming order is popularity: all tees first, then the rest.
  return [...tees, ...ls, ...crews, ...hoods, ...polos, ...tanks, ...hats];
}

test('the first page is no longer dominated by a single category', () => {
  const ordered = diversifyByCategory(sampleCatalog());
  const firstPage = ordered.slice(0, 24);

  const counts = {};
  for (const s of firstPage) counts[s.category] = (counts[s.category] || 0) + 1;
  const topCategoryShare = Math.max(...Object.values(counts)) / firstPage.length;

  // Before: 24/24 = 100% T-Shirts. After: no category should own the page.
  assert.ok(topCategoryShare <= 0.5, `one category still dominates: ${JSON.stringify(counts)}`);
  // At least 5 distinct garment types visible up top.
  assert.ok(Object.keys(counts).length >= 5, `too few categories on page 1: ${JSON.stringify(counts)}`);
});

test('the first page shows a real spread of prices, not one repeated number', () => {
  const ordered = diversifyByCategory(sampleCatalog());
  const firstPage = ordered.slice(0, 24);

  const priceCounts = {};
  for (const s of firstPage) priceCounts[s.priceFrom] = (priceCounts[s.priceFrom] || 0) + 1;
  const mostCommonShare = Math.max(...Object.values(priceCounts)) / firstPage.length;

  // The exact symptom the owner flagged: "majority the same number." Guard it.
  assert.ok(mostCommonShare < 0.5, `majority of cards share one price: ${JSON.stringify(priceCounts)}`);
  assert.ok(Object.keys(priceCounts).length >= 4, `too few distinct prices: ${JSON.stringify(priceCounts)}`);
});

test('the very first card is still the #1 best-seller (top of popularity order)', () => {
  const cat = sampleCatalog();
  const ordered = diversifyByCategory(cat);
  assert.equal(ordered[0].style, cat[0].style);   // top tee leads
  assert.equal(ordered.length, cat.length);        // nothing dropped
});

test('every style is preserved exactly once (no loss, no duplication)', () => {
  const cat = sampleCatalog();
  const ordered = diversifyByCategory(cat);
  assert.equal(ordered.length, cat.length);
  assert.equal(new Set(ordered.map((s) => s.style)).size, cat.length);
});

test('degenerate inputs are handled', () => {
  assert.deepEqual(diversifyByCategory([]), []);
  assert.deepEqual(diversifyByCategory(null), []);
  const one = [{ style: 'a', category: 'Hats' }];
  assert.deepEqual(diversifyByCategory(one).map((s) => s.style), ['a']);
});
