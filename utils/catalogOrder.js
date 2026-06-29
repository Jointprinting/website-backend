// utils/catalogOrder.js
//
// Ordering for the unfiltered "All Styles" catalog landing view.
//
// The catalog is popularity-sorted, and the most-popular styles are almost all
// cheap commodity tees (Gildan/Hanes basics) — so the first page a visitor sees
// was a wall of near-identically-priced shirts (every card ~$5–7). That reads as
// "the prices are broken" even when each price is correct.
//
// diversifyByCategory round-robins across garment categories while preserving
// popularity *within* each category: card 1 is still the #1 best-seller, but
// cards 2..N step through hoodies, polos, crews, tanks, etc. — so the first page
// spans garment types and therefore price points (tee $5, hoodie $18, polo $15,
// crew $14 …) instead of one repeated number. Pure, no deps — unit-tested.
//
// Only used for the unfiltered library view. When a visitor filters to a single
// category (e.g. "T-Shirts"), they WANT all tees, and prices there already vary
// by blank cost within the category, so the natural popularity order is kept.

function diversifyByCategory(styles) {
  const list = Array.isArray(styles) ? styles : [];
  if (list.length < 3) return list.slice();

  // Bucket by category, preserving the incoming (popularity) order within each.
  // Map iteration order = first-appearance order, so the most-popular category
  // (tees) leads the round-robin and the very first card stays the top seller.
  const buckets = new Map();
  for (const s of list) {
    const key = (s && s.category) || 'Other';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }

  const queues = [...buckets.values()];
  const out = [];
  let drained = false;
  while (!drained) {
    drained = true;
    for (const q of queues) {
      if (q.length) { out.push(q.shift()); drained = false; }
    }
  }
  return out;
}

module.exports = { diversifyByCategory };
