// utils/colorSplit.js
//
// A RUN IS DEFINED BY ITS INK, AND THE CLIENT SPLITS IT ACROSS GARMENT COLOURS.
//
// The owner's rule, in his words: "if they want 75 maroon and 75 white shirts
// with black ink that's feasible and they would get a better price at the 150
// unit mark since it can be combined — but if it was 75 maroon w black ink and
// 75 black with white ink those can't be combined."
//
// So the thing that makes two runs separable is the PRINT, not the garment. One
// quote row = one print job (one ink, one spec — he labels them "black ink" /
// "white ink"). Under that row the client picks any of the garment colours he
// offered, with a quantity each. Those quantities ADD UP, and their total is
// what selects the price tier. Two rows with different ink never combine.
//
// This replaces asking the client to pick one fixed quantity chip. A client who
// wants three colours at 150 each could not express 450 that way — the chips are
// 50/100/150 and picking three of them is 300 of nothing anyone ordered. They
// type quantities instead, and the tier follows the total.
//
// MIRRORED on the client in website-frontend/src/common/colorSplit.js — keep the
// two identical (same discipline as the CRM stages / tax rates / mockup numbers).
// The client page computes the live price from these rules and the server
// re-derives it on submit; a divergence would quote a number we then don't honour.

const n = (v) => (Number(v) > 0 ? Number(v) : 0);
const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

// Total units across a colour split.
function splitTotal(split) {
  return (Array.isArray(split) ? split : []).reduce((s, c) => s + n(c && c.qty), 0);
}

// What this line is actually ORDERED at. A split's total is the truth when one
// exists (the client typed it); otherwise the line's own tier quantity stands.
// Used by the money math so a 450-unit split priced off the 150 tier bills 450
// units, not 150.
function orderedQty(line) {
  const t = splitTotal(line && line.colorSplit);
  return t > 0 ? t : n(line && line.qty);
}

// The tier line a total lands on: the largest run size at or below it. Mirrors
// how the print catalog already tiers (printerPricing.floorTier) — a quantity
// prices at the biggest break it reaches, so 175 pays the 150 price and 449 pays
// the 300 one. Below the smallest break there is no tier: the caller reports the
// minimum rather than silently selling under it.
function tierLineFor(rowLines, total) {
  const rows = (Array.isArray(rowLines) ? rowLines : []).filter(Boolean);
  if (!rows.length) return null;
  const t = n(total);
  let best = null;
  for (const l of rows) {
    const q = n(l.qty);
    if (q > 0 && t >= q && (!best || q > n(best.qty))) best = l;
  }
  return best;
}

// The smallest run size offered on a row — the MOQ for that print job.
function minRunFor(rowLines) {
  const qs = (Array.isArray(rowLines) ? rowLines : [])
    .map((l) => n(l && l.qty)).filter((q) => q > 0);
  return qs.length ? Math.min(...qs) : 0;
}

// Validate a client's split against what the owner actually offered.
// Returns { ok, total, message, split } with the split normalized to the
// offered colours (names snapped to the owner's spelling, zero/unknown dropped).
//
// Deliberately strict about WHICH colours: the offer is the owner's curated
// list, checked against S&S stock when he built it, so a colour that is not on
// it is one nobody has confirmed exists in that garment.
function validateSplit(offered, split, rowLines) {
  const list = (Array.isArray(offered) ? offered : []).filter(Boolean);
  const byName = new Map(list.map((c) => [norm(c.name), c]));
  const byCode = new Map(list.filter((c) => c.code).map((c) => [norm(c.code), c]));

  const seen = new Set();
  const clean = [];
  for (const c of Array.isArray(split) ? split : []) {
    const qty = n(c && c.qty);
    if (!qty) continue;
    const hit = byName.get(norm(c && c.name)) || byCode.get(norm(c && c.code));
    if (!hit) return { ok: false, total: 0, split: [], message: `We don't have "${(c && c.name) || 'that colour'}" on this design — please pick from the colours shown.` };
    const key = norm(hit.name);
    if (seen.has(key)) return { ok: false, total: 0, split: [], message: `${hit.name} is listed twice — please put its whole quantity on one line.` };
    seen.add(key);
    clean.push({ name: hit.name, code: hit.code || '', hex: hit.hex || '', qty });
  }

  const total = splitTotal(clean);
  if (!total) return { ok: false, total: 0, split: [], message: 'Enter how many of each colour you need.' };

  const min = minRunFor(rowLines);
  if (min > 0 && total < min) {
    return { ok: false, total, split: clean, message: `This design runs from ${min} pieces — you have ${total}. Add ${min - total} more across any colours.` };
  }
  return { ok: true, total, split: clean, message: '' };
}

// The RUN a line belongs to — its style, product, print spec and colour label.
// Identical to the client's quoteGrid.quoteRowKey, because a "row" in the
// owner's design grid IS one run: the set of lines that differ only by run size.
// A colour-split row carries no single `color` (its colours are colorOptions),
// so that part is simply empty for them and the key still matches exactly.
function runKey(l) {
  return ['styleCode', 'description', 'printDetails', 'color']
    .map((k) => norm(l && l[k])).join('|');
}

// Every line of one run, in the served view — the run's price-break table.
function runLines(view, line) {
  const k = runKey(line);
  return (Array.isArray(view) ? view : [])
    .filter((l) => l && l.group === line.group && runKey(l) === k);
}

module.exports = { splitTotal, orderedQty, tierLineFor, minRunFor, validateSplit, runKey, runLines };
