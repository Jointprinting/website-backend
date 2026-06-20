// Alphabroder (Decorator) — seed rate card, from "US DECORATION PRICING_ALL
// _June_2024.pdf" (Drive; in-doc effective June 2023). National decorator (PA).
// APPAREL DECORATION = screen print + embroidery (also heat seal — single-row
// by qty, left out for now; no DTG/DTF). Qty in PIECES, per logo/location.
//
// Screen print has explicit WHITE and COLORED grids (1-8 colors). The colored
// grid already bakes in the underbase (it equals the white grid shifted one
// color), so we use both grids directly with NO extra underbase rule. 48-pc
// minimum; 1,000+ pcs = call (null rows). Embroidery is a single price-by-qty
// row covering one logo / one location / ≤10,000 stitches.

const SP_COLS = [];
for (let i = 1; i <= 8; i++) SP_COLS.push({ key: String(i), label: `${i} color${i > 1 ? 's' : ''}`, min: i, max: i });
const SP_QTY = [48, 72, 144, 288, 576, 1000];
const SP_WHITE = [
  [1.38, 1.73, 2.07, 2.62, 3.14, 3.66, 4.19, 4.71],
  [1.10, 1.38, 1.66, 2.09, 2.54, 2.99, 3.44, 3.89],
  [0.97, 1.17, 1.38, 1.72, 2.02, 2.32, 2.62, 2.92],
  [0.90, 1.04, 1.17, 1.42, 1.65, 1.87, 2.09, 2.32],
  [0.75, 0.83, 0.97, 1.20, 1.42, 1.64, 1.87, 2.09],
  [null, null, null, null, null, null, null, null],
];
const SP_COLORED = [
  [1.73, 2.07, 2.62, 3.14, 3.66, 4.19, 4.71, 5.23],
  [1.38, 1.66, 2.09, 2.54, 2.99, 3.44, 3.89, 4.34],
  [1.17, 1.38, 1.72, 2.02, 2.32, 2.62, 2.92, 3.21],
  [1.04, 1.17, 1.42, 1.64, 1.87, 2.09, 2.32, 2.54],
  [0.83, 0.97, 1.20, 1.42, 1.64, 1.87, 2.09, 2.32],
  [null, null, null, null, null, null, null, null],
];
const SP_ADDONS = [
  { key: 'poly',  label: 'Polyester (+$0.30)', amount: 0.30, per: 'unit' },
  { key: 'fold',  label: 'Fold & poly bag (+$0.30)', amount: 0.30, per: 'unit' },
  { key: 'pms',   label: 'PMS color match ($32 flat)', perQuote: true },
];

module.exports = {
  printerName: 'Alphabroder',
  region: 'West', state: 'National (PA)',
  sourceFile: 'US DECORATION PRICING_ALL_June_2024.pdf', effectiveDate: '2023-06-05',
  notes: 'National decorator (Trevose PA). Screen print (1-8 colors, White vs Colored grids) + '
       + 'embroidery (single price by qty, ≤10k st incl.). Per logo/location. 48-pc minimum; '
       + '1,000+ screen pcs = call. Heat seal available (not yet loaded). No DTG/DTF.',
  groups: [
    {
      id: 'sp_light', method: 'screen_print', label: 'Screen print — white garment',
      selectorDim: 'garment_shade', selectorValue: 'light',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_WHITE,
      fees: [{ kind: 'per_color', label: 'Screen', amount: 25 }],
      addOns: SP_ADDONS,
      notes: '48-pc minimum. 1,000+ pcs = call for quote (null row).',
    },
    {
      id: 'sp_dark', method: 'screen_print', label: 'Screen print — colored garment',
      selectorDim: 'garment_shade', selectorValue: 'dark',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_COLORED,
      fees: [{ kind: 'per_color', label: 'Screen', amount: 25 }],
      addOns: SP_ADDONS,
      notes: 'Colored grid already includes the underbase (= white grid + 1 color). No extra rule applied.',
    },
    {
      id: 'emb', method: 'embroidery', label: 'Embroidery (one logo, ≤10k stitches)',
      quantityUnit: 'pieces', columnAxis: 'none', perLocation: true,
      qtyBreaks: [1, 6, 12, 300, 1200],
      columns: [{ key: 'logo', label: 'per logo (≤10k st)' }],
      grid: [[17.50], [8.00], [3.50], [2.75], [2.50]],
      fees: [{ kind: 'digitizing', label: 'Digitizing (free 24+ orders; else $10/1,000 st)', amount: 0, estimate: true }],
      addOns: [{ key: 'over_10k', label: 'Over 10,000 stitches (+$0.50/1,000)', perQuote: true }],
      notes: 'Base covers one logo, one location, ≤10,000 stitches (fold & poly bag incl.). '
           + 'Per location. Over 10k st = +$0.50/1,000.',
    },
  ],
};
