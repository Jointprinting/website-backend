// utils/quoteGroups.js
//
// HOW MANY OPTIONS OF ONE GROUP MAY THE CLIENT TAKE?
//
// A quote `group` has always meant "these are alternatives — pick ONE" (see the
// schema note on Order.quoteLines.group). That is right for brands: Gildan vs
// Bella vs Next Level is a choice, and taking two would be nonsense.
//
// It is WRONG for colourways. "50 black + 50 white of the same design" is not a
// choice between two options, it is two production runs the client wants BOTH
// of. Under pick-one the second colour has nowhere to go, which is exactly the
// order that prompted this: the client could take the 50 and the other 50 was
// unsellable on the link. The owner's own words — "there weren't color options".
//
// So a group now carries a MODE:
//   • one_of  — alternatives (brands, print variants). The historical behaviour.
//   • any_of  — co-produced options (colourways). Take any combination; the
//               quantities ADD UP rather than replacing each other.
//
// The mode is DERIVED by default so the owner never has to configure the common
// case, and can be pinned per group when the derivation reads it wrong (he might
// genuinely want "pick your favourite colour, black or white" — one_of).
//
// NOTE ON PRICING: an any_of group does NOT combine its quantities into a better
// price tier, and must not. Per the owner: "if someone does 50 black with white
// print and 50 white with black print i cant combine the quantity for a better
// price, it would have to be separate" — different garment shades mean different
// screens and a different ink lane (see printerPricing's light/dark grids), so
// each colour keeps its own line, its own setup and its own tier. This module
// decides only what the client may SELECT, never what anything costs.
//
// MIRRORED on the client in website-frontend/src/common/quoteGrid.js — keep the
// two identical (same rule the CRM stages / tax rates / mockup numbers follow).
// utils/__tests__/quoteGroups.test.js locks the shared cases.

const VALID_MODES = ['one_of', 'any_of'];

const s = (v) => String(v == null ? '' : v).trim().toLowerCase();

// Row identity WITHOUT the colour — "which design is this line about". Mirrors
// quoteGrid.quoteRowKey minus `color`, so a set of lines that share a design and
// differ only in colour collapses to exactly one of these.
const designKey = (l) => ['styleCode', 'description', 'printDetails'].map((k) => s(l && l[k])).join('|');

// An owner-pinned mode on any line of the group wins. Stored per line the same
// way `group` itself is (a group is not its own document), so the first non-empty
// value found is the group's.
function pinnedMode(lines) {
  for (const l of lines || []) {
    const m = s(l && l.groupMode);
    if (VALID_MODES.includes(m)) return m;
  }
  return '';
}

// Are these lines colourways of ONE design — same style/product/print spec,
// differing only in garment colour? That is the shape that should add up rather
// than replace.
function isColourSet(lines) {
  const ls = (lines || []).filter(Boolean);
  if (ls.length < 2) return false;
  // Every line must name a colour; a blank colour means the owner is expressing
  // the option some other way (usually in `description`) and we must not guess.
  if (ls.some((l) => !s(l.color))) return false;
  const colours = new Set(ls.map((l) => s(l.color)));
  if (colours.size < 2) return false;
  return new Set(ls.map(designKey)).size === 1;
}

// The mode for one group's lines: pinned if the owner set one, else derived.
function groupPickMode(lines) {
  return pinnedMode(lines) || (isColourSet(lines) ? 'any_of' : 'one_of');
}

// { groupName: 'one_of' | 'any_of' } for a whole quote. Ungrouped lines are
// always-included standalones and carry no mode.
function groupPickModes(lines) {
  const byGroup = new Map();
  for (const l of lines || []) {
    const g = l && l.group;
    if (!g) continue;
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(l);
  }
  const out = {};
  for (const [g, ls] of byGroup) out[g] = groupPickMode(ls);
  return out;
}

// How many picks are allowed in this group? Infinity for any_of.
function maxPicksForGroup(lines) {
  return groupPickMode(lines) === 'any_of' ? Infinity : 1;
}

module.exports = {
  VALID_MODES, designKey, isColourSet, groupPickMode, groupPickModes, maxPicksForGroup,
};
