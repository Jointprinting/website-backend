// services/promoCatalog.js
//
// Pure helpers behind the promo catalog (models/PromoProduct, the Quoter's
// promo picker). No DB, no HTTP — unit-tested in services/__tests__.

const num = (v) => Number(v) || 0;

// Clean one raw catalog product (from the seed file or POST /import) into the
// shape the model stores. Unknown fields drop; breaks are sorted ascending by
// qty and de-duplicated (last write wins per qty); a product with no name is
// rejected (returns null).
function normalizePromoProduct(raw = {}) {
  const name = String(raw.name || '').trim();
  if (!name) return null;
  const cleanBreaks = (arr, valKey) => {
    const byQty = new Map();
    for (const b of Array.isArray(arr) ? arr : []) {
      const qty = Math.round(num(b && b.qty));
      const val = num(b && b[valKey]);
      if (qty > 0 && val > 0) byQty.set(qty, val);
    }
    return [...byQty.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([qty, val]) => ({ qty, [valKey]: val }));
  };
  const moq = raw.moq == null || raw.moq === '' ? null : Math.round(num(raw.moq)) || null;
  return {
    name,
    sku: String(raw.sku || '').trim(),
    variant: String(raw.variant || '').trim().toLowerCase(),
    category: String(raw.category || '').trim(),
    description: String(raw.description || '').trim(),
    moq,
    turnaround: String(raw.turnaround || '').trim(),
    printMethod: String(raw.printMethod || '').trim(),
    printCost: String(raw.printCost || '').trim(),
    setupCostClient: String(raw.setupCostClient || '').trim(),
    setupCostNet: String(raw.setupCostNet || '').trim(),
    clientPriceBreaks: cleanBreaks(raw.clientPriceBreaks, 'price'),
    netCostBreaks: cleanBreaks(raw.netCostBreaks, 'cost'),
    flags: (Array.isArray(raw.flags) ? raw.flags : []).map((f) => String(f)).filter(Boolean).slice(0, 20),
  };
}

// The break a given quantity actually prices at: the largest tier whose qty is
// ≤ the requested quantity — vendor price lists read "at 500+, this price".
// Below the lowest tier there IS no price (that's under the de-facto minimum):
// returns the LOWEST tier and flags belowMinimum so the caller can warn.
function breakAt(breaks, qty, valKey) {
  const arr = Array.isArray(breaks) ? breaks : [];
  if (!arr.length) return { qty: 0, value: 0, belowMinimum: false };
  const q = num(qty);
  let best = null;
  for (const b of arr) if (b.qty <= q && (!best || b.qty > best.qty)) best = b;
  if (best) return { qty: best.qty, value: num(best[valKey]), belowMinimum: false };
  const lowest = arr[0];
  return { qty: lowest.qty, value: num(lowest[valKey]), belowMinimum: true };
}

// Both sides of the money for one product at one quantity, plus the caveats a
// quote needs to surface: the client price + net cost at that run size, the
// margin between them, and whether the qty sits under the tier floor / MOQ.
function quoteAt(product, qty) {
  const p = product || {};
  const q = num(qty);
  const client = breakAt(p.clientPriceBreaks, q, 'price');
  const net = breakAt(p.netCostBreaks, q, 'cost');
  const price = client.value;
  const cost = net.value;
  const marginPct = price > 0 && cost > 0 ? ((price - cost) / price) * 100 : null;
  const minQty = Math.max(
    p.moq || 0,
    (p.clientPriceBreaks && p.clientPriceBreaks[0] ? p.clientPriceBreaks[0].qty : 0) || 0,
  );
  return {
    price, cost, marginPct,
    priceTierQty: client.qty, costTierQty: net.qty,
    belowMinimum: q < minQty || client.belowMinimum,
    minQty: minQty || null,
  };
}

module.exports = { normalizePromoProduct, breakAt, quoteAt };
