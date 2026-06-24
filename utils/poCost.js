// utils/poCost.js
//
// THE single source of truth for "what lines/items count on a supplier PO" and
// "what does that line cost the vendor" (per-unit + setup). Both PO seeders in
// controllers/purchaseOrders.js call this, so the SAME job produces an IDENTICAL
// vendor PO whether it's built manually from the quote ("New PO") or generated
// from the approved confirmation ("Generate POs from confirmation"). Mirrors the
// canonical quote/confirmation line-selection (Order.computeQuoteTotals /
// frontend chosenQuoteLines) so the PO can never disagree with them about which
// lines are real.
//
// ── CANONICAL PO COST BASIS ───────────────────────────────────────────────────
//   • PO line unit cost = blank cost/unit (ONLY when the owner does NOT supply
//     the blanks — blanksProvided === false) + print/decoration cost/unit.
//     When the owner supplies blanks (the ~99% case, blanksProvided === true),
//     the blank cost is NOT a supplier cost and is excluded from the PO.
//   • setup / screen charges get their OWN PO line — never folded into unit cost.
//   • shipping / freight is EXCLUDED entirely — it is not a per-unit supplier
//     cost on the PO (the older confirmation seeder wrongly baked it into the
//     unit cost, inflating the vendor total by freight; this removes it).
//
// Everything here is pure (no DB, no Mongoose) so it is unit-testable and can be
// imported by either seeder. The money helpers mirror controllers/purchaseOrders.js.

const num = (v) => Number(v) || 0;
const money = (v) =>
  `$${num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Normalize a vendor name into a stable slug for grouping / numbering / skip
// checks. Trim, collapse internal whitespace, lowercase. MUST match
// utils/sequence.js slug semantics for the bits that matter (the sequence slug
// strips to [a-z0-9]+ runs, which subsumes whitespace-collapsing) so the key
// used to GROUP a PO is the same key used to NUMBER it and to SKIP it.
const vendorKey = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();

// Selection key for a confirmation item ↔ quote line match and for the
// "+From quote" dedupe: style + color + print variant. Two lines that differ
// only by print type/decoration are DISTINCT and must not collapse (H4).
const lineKey = (o) => [
  o && (o.styleCode || o.style || ''),
  o && (o.color || ''),
  o && (o.printType || ''),
  o && (o.printDetails || o.printDetail || ''),
].map((s) => String(s || '').trim().toLowerCase()).join('|');

// ── Canonical line selection ──────────────────────────────────────────────────
// Mirrors Order.computeQuoteTotals / frontend chosenQuoteLines: once the client
// has accepted any option, only accepted lines + standalone (ungrouped) lines +
// any group added after the pick (no accepted line yet) are the real order.
function chosenQuoteLines(lines) {
  const arr = Array.isArray(lines) ? lines : [];
  if (!arr.some((l) => l && l.accepted)) return arr.filter(Boolean);
  const decided = new Set(arr.filter((l) => l && l.accepted).map((l) => l.group));
  return arr.filter((l) => l && (l.accepted || !l.group || !decided.has(l.group)));
}

// Normalize a quote line into the shared "cost line" shape the PO builder uses.
function costLineFromQuoteLine(line, blanksProvided) {
  const l = line || {};
  const blank = blanksProvided ? 0 : num(l.blankCost);
  return {
    name: String(l.description || l.styleCode || 'Item').trim() || 'Item',
    color: String(l.color || '').trim(),
    printType: String(l.printType || '').trim(),
    printDetails: String(l.printDetails || '').trim(),
    qty: num(l.qty),
    unitCost: blank + num(l.printCost),   // freight excluded; blank only when owner doesn't supply
    setupCost: num(l.setupCost),          // its own PO line (never folded in)
    sizes: [],                            // quote lines carry no size run
  };
}

// Normalize a confirmation item into the same shared shape. Confirmation items
// only carry a single bundled `unitCost` (blank+print+setup/qty, from
// seedItemFromQuote) — too coarse to honor blanksProvided or split setup. So we
// recover the granular cost from the order's matching quote line when we can
// (same style|color|print). When matched, the PO is IDENTICAL to the manual
// seeder for that line. With no match we fall back to the item's bundled unitCost
// treated as decoration-only (blank already either absent or unrecoverable), so a
// hand-added confirmation item still prices — and a zero is surfaced, not hidden.
function costLineFromConfItem(item, blanksProvided, quoteLineByKey) {
  const it = item || {};
  const sizes = Array.isArray(it.sizes) ? it.sizes : [];
  const qty = sizes.reduce((s, sz) => s + num(sz.qty), 0);
  const name = String(it.productName || '').trim()
    || [it.brandName, it.styleCode].map((s) => String(s || '').trim()).filter(Boolean).join(' ')
    || 'Item';
  const match = quoteLineByKey instanceof Map ? quoteLineByKey.get(lineKey(it)) : null;
  let unitCost;
  let setupCost;
  if (match) {
    const blank = blanksProvided ? 0 : num(match.blankCost);
    unitCost = blank + num(match.printCost);
    setupCost = num(match.setupCost);
  } else {
    // No granular source — the confirmation's unitCost is the only cost we have.
    // Default to 0 explicitly (C3) so an unpriced hand-added item is a real,
    // flaggable $0 rather than NaN/undefined.
    unitCost = num(it.unitCost);
    setupCost = 0;
  }
  return {
    name,
    color: String(it.color || '').trim(),
    printType: String(it.printType || '').trim(),
    printDetails: String(it.printDetails || '').trim(),
    qty,
    unitCost,
    setupCost,
    sizes,
    matched: !!match,
  };
}

// Build the PO `items` (lettered display) + `charges` (rolls into grand total)
// for a list of normalized cost lines. ONE implementation for both seeders.
//
// opts.detailFor(costLine) may return extra detail strings (e.g. the size run
// or the ship-split line) appended after the cost line — keeps the per-path
// flavor without forking the cost math.
//
// Returns { items, charges, grandTotal, zeroCostCount } where zeroCostCount is
// the number of lines that carry quantity but no per-unit cost (C3) so callers
// can warn instead of silently emitting a $0 line.
function buildPoLines(costLines, opts) {
  const o = opts || {};
  const items = [];
  const charges = [];
  let zeroCostCount = 0;

  (Array.isArray(costLines) ? costLines : []).forEach((cl) => {
    const qty = num(cl.qty);
    const unitCost = num(cl.unitCost);
    const setupCost = num(cl.setupCost);
    const colorTitle = cl.color ? `${cl.name}, ${cl.color}` : cl.name;
    const title = `${colorTitle}${qty ? `, ${qty} units` : ''}`;

    const details = [];
    // Print/decoration line, e.g. "Screen Print · 1 color front · Black".
    if (cl.printType || cl.printDetails) {
      details.push([cl.printType, cl.printDetails, cl.color].filter(Boolean).join(' · '));
    }
    const extra = typeof o.detailFor === 'function' ? o.detailFor(cl) : [];
    (Array.isArray(extra) ? extra : [extra]).filter(Boolean).forEach((d) => details.push(d));
    if (unitCost && qty) details.push(`${money(unitCost)}/unit * ${qty} units = ${money(unitCost * qty)}`);
    if (setupCost) details.push(`${money(setupCost)} setup`);
    items.push({ title, details });

    if (unitCost && qty) {
      charges.push({ label: `${colorTitle}: ${money(unitCost)}/unit * ${qty} units`, amount: unitCost * qty });
    } else if (qty > 0 && unitCost <= 0) {
      // Qty present but no per-unit cost → this would be a silent $0 line. Count
      // it so the API + builder can warn the owner to fill it in (C3).
      zeroCostCount += 1;
    }
    if (setupCost) {
      charges.push({ label: `${cl.name} set-up fee`, amount: setupCost });
    }
  });

  const grandTotal = charges.reduce((s, c) => s + num(c.amount), 0);
  return { items, charges, grandTotal, zeroCostCount };
}

module.exports = {
  vendorKey,
  lineKey,
  chosenQuoteLines,
  costLineFromQuoteLine,
  costLineFromConfItem,
  buildPoLines,
  _money: money,
};
