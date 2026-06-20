// Arcadia Printing — seed rate card, from "DTG & DTF Pricing" (Drive Google
// Doc). Tulsa OK. APPAREL DECORATION = DTG + DTF, priced identically. This guide
// has NO quantity breaks and NO size/shade matrix — it's a flat per-PLACEMENT
// price (same per piece at any quantity; over 200 pcs = custom quote). So the
// "tier" here is the print placement, and there's a single (flat) quantity row.
// No setup fee or minimum stated.

const PLACEMENTS = [
  { key: 'left_chest',  label: 'Left chest' },
  { key: 'tag_back',    label: 'Tag back' },
  { key: 'full_front',  label: 'Full front / back (14x16)' },
  { key: 'oversized',   label: 'Oversized front / back (16x21)' },
  { key: 'sleeve',      label: 'Sleeve' },
  { key: 'full_sleeve', label: 'Full sleeve' },
];
const ROW = [[3.50, 3.50, 5.60, 7.70, 4.90, 5.60]];  // flat — one quantity row
const ADDONS = [
  { key: 'private_label', label: 'Private labeling (+$2.80)', amount: 2.80, per: 'unit' },
  { key: 'special_place', label: 'Special placement (+$1.00)', amount: 1.00, per: 'unit' },
  { key: 'over_200',      label: 'Over 200 pcs — custom quote', perQuote: true },
];
const group = (method, label) => ({
  id: method, method, label,
  quantityUnit: 'pieces', columnAxis: 'imprint_size', perLocation: false,
  qtyBreaks: [1], columns: PLACEMENTS, grid: ROW,
  minOrder: 0, addOns: ADDONS,
  notes: 'Flat per-placement price (no qty breaks under 200). DTF Full Front standard width 11". '
       + 'Pick the placement; price does not vary by garment shade.',
});

module.exports = {
  printerName: 'Arcadia Printing',
  region: 'Mid', state: 'OK',
  sourceFile: 'Arcadia DTG & DTF Pricing (Doc)', effectiveDate: '2025-12-10',
  notes: 'Tulsa OK. DTG + DTF only, priced identically by PLACEMENT (flat per piece, no qty '
       + 'breaks under 200). Same prices apply to DTG and DTF.',
  groups: [
    group('dtg', 'DTG (by placement)'),
    group('dtf', 'DTF (by placement)'),
  ],
};
