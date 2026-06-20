// Deterministic printer-pricing lookup. Given a rate card (see
// models/PrinterRateCard) and one line's inputs, it returns the printer's COST
// for that decoration — per-unit print cost + setup — or flags the case as
// "needs a manual quote". No randomness, no AI: every number comes straight
// from the printer's matrix, so a quote is reproducible and auditable.

const num = (v) => Number(v) || 0;
const round2 = (v) => Math.round((num(v) + Number.EPSILON) * 100) / 100;

// Largest break <= qty (you qualify for the price at the break you reach),
// floored at the smallest break. Returns the row index into qtyBreaks/grid.
function snapBreakIndex(breaks, qty) {
  let idx = 0;
  for (let i = 0; i < breaks.length; i++) if (qty >= breaks[i]) idx = i;
  return idx;
}

// Resolve the selector input value for a group's selectorDim.
function selectorValue(input, dim) {
  const map = {
    garment_shade: input.garmentShade,
    product:       input.product,
    sides:         input.sides,
  };
  return String(map[dim] ?? input[dim] ?? '').trim().toLowerCase();
}

function pickGroup(card, input) {
  const groups = (card.groups || []).filter(g => g.method === input.method);
  if (groups.length <= 1) return groups[0] || null;
  const match = groups.find(g => g.selectorDim &&
    selectorValue(input, g.selectorDim) === String(g.selectorValue).trim().toLowerCase());
  return match || groups.find(g => !g.selectorDim) || groups[0];
}

// Column index whose tier contains the input value. Numeric axes use min/max
// ranges; keyed axes match `key`. -1 = no match.
function columnIndex(group, input) {
  const cols = group.columns || [];
  if (cols.length === 0) return -1;
  const axis = group.columnAxis;
  if (axis === 'ink_colors' || axis === 'stitch_band') {
    const v = axis === 'ink_colors' ? input._effectiveColors : num(input.stitchCount);
    return cols.findIndex(c =>
      v >= (c.min == null ? -Infinity : c.min) && v <= (c.max == null ? Infinity : c.max));
  }
  if (axis === 'imprint_size' || axis === 'sides') {
    const key = String((axis === 'imprint_size' ? input.imprintSize : input.sides) || '').trim().toLowerCase();
    return cols.findIndex(c => String(c.key).trim().toLowerCase() === key);
  }
  return 0; // axis 'none' → single column
}

// input: { method, quantity, numColors?, numLocations?, garmentShade?,
//          stitchCount?, imprintSize?, sides?, product? }
function lookupPrice(card, input) {
  const out = {
    ok: false, method: input && input.method,
    unitPrintCost: 0, setupCost: 0, addOns: [], availableAddOns: [], flags: [], breakdown: {},
  };
  if (!card) { out.flags.push('No rate card on file for this printer.'); return out; }
  if (!input || !input.method) { out.flags.push('No decoration method given.'); return out; }

  const group = pickGroup(card, input);
  if (!group) { out.flags.push(`This printer has no ${input.method.replace(/_/g, ' ')} pricing.`); return out; }

  // Dark-garment underbase rule bumps the effective color/screen count.
  let effColors = num(input.numColors);
  if ((group.rules || []).includes('dark_underbase_add_color') && effColors > 0) effColors += 1;
  input._effectiveColors = effColors;

  // Quantity → row break. Screen-print grids are keyed in DOZENS (an easy
  // off-by-12 trap), so convert pieces → dozens when the grid says so.
  const qtyUnits = group.quantityUnit === 'dozens' ? num(input.quantity) / 12 : num(input.quantity);
  const breaks = group.qtyBreaks || [];
  if (breaks.length === 0) { out.flags.push('This grid has no quantity breaks set.'); return out; }
  const rowIdx = snapBreakIndex(breaks, qtyUnits);
  const colIdx = columnIndex(group, input);
  if (colIdx < 0) { out.flags.push('No matching price tier — needs a manual quote.'); return out; }

  const cell = (group.grid && group.grid[rowIdx]) ? group.grid[rowIdx][colIdx] : null;
  if (cell == null) { out.flags.push('That quantity / tier isn’t on the matrix — needs a manual quote.'); return out; }

  const locations = Math.max(1, num(input.numLocations) || 1);
  // Area-priced groups (e.g. DTF, charged $/sq-in) multiply the rate by the
  // design area; everything else uses the grid value as the per-unit price.
  let perUnit;
  if (group.areaPriced) {
    const area = num(input.areaSqIn);
    if (area <= 0) out.flags.push('Enter the design area (sq in) to price this.');
    perUnit = round2(num(cell) * area * (group.perLocation ? locations : 1));
  } else {
    perUnit = round2(num(cell) * (group.perLocation ? locations : 1));
  }

  // Setup: per-screen/per-color fees scale with color count (and locations on
  // per-location grids); flat/digitizing fees are one-time. A 'per_unit' fee is
  // a flat per-piece surcharge (e.g. a flash charge) folded into the unit cost.
  let setup = 0;
  const feeLines = [];
  (group.fees || []).forEach((f) => {
    if (f.kind === 'per_unit') {
      perUnit = round2(perUnit + num(f.amount) * (group.perLocation ? locations : 1));
      return;
    }
    let amt = 0;
    if (f.kind === 'per_screen' || f.kind === 'per_color') {
      amt = num(f.amount) * Math.max(1, effColors) * (group.perLocation ? locations : 1);
    } else {
      amt = num(f.amount);
    }
    setup += amt;
    feeLines.push({ label: f.label || f.kind, amount: round2(amt), estimate: !!f.estimate });
  });

  // Add-ons are AVAILABLE options for this group; the lookup applies/flags only
  // the ones the caller selected (input.selectedAddOns), so unrelated extras
  // don't pollute every quote. Per-unit add-ons adjust the unit cost; per-order
  // flat add-ons roll into setup; per-quote ones just flag.
  const selected = new Set((input.selectedAddOns || []).map(String));
  (group.addOns || []).forEach((a) => {
    out.availableAddOns.push({ key: a.key, label: a.label || a.key, amount: num(a.amount), isPercent: !!a.isPercent, per: a.per || 'unit', perQuote: !!a.perQuote });
    if (!selected.has(String(a.key))) return;
    if (a.perQuote) { out.flags.push(`${a.label || a.key}: needs a manual quote.`); return; }
    out.addOns.push({ key: a.key, label: a.label || a.key, amount: num(a.amount), isPercent: !!a.isPercent, per: a.per || 'unit' });
    if ((a.per || 'unit') === 'unit') {
      perUnit = a.isPercent ? round2(perUnit * (1 + num(a.amount) / 100)) : round2(perUnit + num(a.amount));
    } else if (a.per === 'order') {
      setup += num(a.amount);
    }
  });

  const lineTotalPrint = round2(perUnit * num(input.quantity));
  if (group.minOrder && lineTotalPrint < group.minOrder) {
    out.flags.push(`Below this printer's $${group.minOrder} minimum — they'll bill the minimum.`);
  }

  out.ok = true;
  out.unitPrintCost = perUnit;
  out.setupCost = round2(setup);
  out.breakdown = {
    group: group.label || group.id,
    quantityIn: group.quantityUnit === 'dozens' ? `${round2(qtyUnits)} dozen` : `${num(input.quantity)} pcs`,
    qtyBreak: breaks[rowIdx],
    column: (group.columns[colIdx] && (group.columns[colIdx].label || group.columns[colIdx].key)) || '',
    effectiveColors: effColors || undefined,
    areaSqIn: group.areaPriced ? num(input.areaSqIn) : undefined,
    locations,
    unitFromGrid: num(cell),
    fees: feeLines,
  };
  return out;
}

module.exports = { lookupPrice, snapBreakIndex, columnIndex, pickGroup };
