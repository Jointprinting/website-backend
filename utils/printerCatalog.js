// utils/printerCatalog.js
//
// Pure helpers for the app-writable printer price catalog (the 4B editor). The
// catalog is Mixed — every printer's price book has its own shape — so the write
// path validates STRUCTURE (a priced section self-describes a `model` the quoter
// engine can price) rather than a fixed field schema, and it DERIVES the
// printer's capabilities from the sections that are actually present (4D: one
// source of truth, instead of a hand-typed array that can drift from reality).
//
// Kept dependency-free and pure so both the controller and the tests import the
// same rules — the model tags here MUST stay in lockstep with the frontend
// engine's priceMethod() dispatch (src/common/printerPricing.js) or a section the
// owner edits would validate here yet silently fail to price in the Quoter.

// The pricing models the engine can dispatch on. A `qty_x_colors` etc. section
// carries one of these as its `model` tag. Heritage's legacy screen-print block
// carries no tag but a `priceGrids` object — treated as valid too.
const KNOWN_MODELS = [
  'qty_x_colors', 'qty_only', 'qty_x_size_x_shade', 'qty_x_size',
  'qty_x_stitches', 'qty_x_size_sqin', 'gang_sheet_flat', 'gang_qty_x_size',
];

// Section key → canonical capability. The catalog's priced sections are the
// ground truth for "what can this printer actually do"; capabilities are derived
// from them. Non-priced sections (meta/printer/addOns/policies/…) are ignored.
const SECTION_CAPABILITY = {
  screenPrinting:        'screen_printing',
  digitalSqueegee:       'digital_squeegee',
  dtg:                   'dtg',
  dtf:                   'dtf',
  embroidery:            'embroidery',
  digitallyPrintedMedia: 'digitally_printed_media',
  personalization:       'personalization',
};

// Keys that are NEVER a priced section — reference/metadata blocks that ride
// alongside the price books in the same catalog object.
const NON_PRICED_KEYS = new Set([
  'meta', 'printer', 'addOns', 'terms', 'postProduction', 'maxImprintSizes',
  'colorCharts', 'policies', 'flagsForOwner', 'notes', '__archived',
]);

// Is this section a real, engine-priceable price book? True when it's an object
// carrying a KNOWN model tag, or Heritage's legacy priceGrids shape.
function isPricedSection(section) {
  if (!section || typeof section !== 'object' || Array.isArray(section)) return false;
  if (typeof section.model === 'string' && KNOWN_MODELS.includes(section.model)) return true;
  if (section.priceGrids && typeof section.priceGrids === 'object') return true;   // Heritage legacy
  return false;
}

// Validate one section the owner is trying to write. Returns { ok, error }.
// The contract (mirrors the structural guard in printerNetwork.test.js): a
// priced section MUST self-describe a `model` the engine can price (or be the
// legacy priceGrids shape), so a hand-edit can never seed a section the Quoter
// silently can't read.
function validateSection(sectionKey, section) {
  const key = String(sectionKey || '').trim();
  if (!key) return { ok: false, error: 'A section key is required (e.g. "dtg", "screenPrinting").' };
  if (NON_PRICED_KEYS.has(key)) return { ok: false, error: `"${key}" is a reference block, not a price book — edit it as printer meta, not a priced section.` };
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    return { ok: false, error: 'A section must be an object.' };
  }
  if (!isPricedSection(section)) {
    return { ok: false, error: `Section "${key}" needs a recognized "model" tag (one of: ${KNOWN_MODELS.join(', ')}) or a legacy priceGrids block, so the Quoter can price it.` };
  }
  return { ok: true };
}

// Derive the printer's capabilities from the priced sections actually present in
// its catalog (skipping any soft-archived ones). Canonical, de-duped, stable
// order. This is 4D: capabilities stop being a free-text array that can lie about
// what a printer can run, and become a projection of the real price books.
function capabilitiesFromCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object') return [];
  const archived = (catalog.__archived && typeof catalog.__archived === 'object') ? catalog.__archived : {};
  const out = [];
  for (const key of Object.keys(SECTION_CAPABILITY)) {
    if (NON_PRICED_KEYS.has(key)) continue;
    const section = catalog[key];
    if (!section || archived[key]) continue;
    if (!isPricedSection(section)) continue;
    const cap = SECTION_CAPABILITY[key];
    if (!out.includes(cap)) out.push(cap);
  }
  return out;
}

// The priced section keys present (non-archived) — used by the editor + tests.
function pricedSectionKeys(catalog) {
  if (!catalog || typeof catalog !== 'object') return [];
  const archived = (catalog.__archived && typeof catalog.__archived === 'object') ? catalog.__archived : {};
  return Object.keys(catalog).filter(
    (k) => !NON_PRICED_KEYS.has(k) && !archived[k] && isPricedSection(catalog[k]));
}

module.exports = {
  KNOWN_MODELS, SECTION_CAPABILITY, NON_PRICED_KEYS,
  isPricedSection, validateSection, capabilitiesFromCatalog, pricedSectionKeys,
};
