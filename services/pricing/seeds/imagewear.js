// Imagewear — seed rate card, from "Screen Print Pricing.pdf" + "DTGBroker
// Pricing.pdf" (Drive). Cherry Hill NJ. APPAREL DECORATION = screen print + DTG
// (the guides have no embroidery/DTF pricing). Screen qty in PIECES, per print
// location; dark garments = +1 color (white underbase) + $0.50/pc flash. DTG
// priced by imprint size, qty in pieces (print only, garment not included).
//
// ⚠️ Source notes (transcribed AS PRINTED): the screen 5-color @ 24–48 cell
// ($8.10) looks like a typo but is left as-is. The DTG flyer OCR'd messily —
// the 12x12 & 13x17 columns are solid, the small (4x4) column is INFERRED, and
// per-extra-location DTG pricing wasn't clearly readable (add extra sites
// manually). Confirm DTG against the original.

const SP_COLS = [
  { key: '1', label: '1 color',  min: 1, max: 1 },
  { key: '2', label: '2 colors', min: 2, max: 2 },
  { key: '3', label: '3 colors', min: 3, max: 3 },
  { key: '4', label: '4 colors', min: 4, max: 4 },
  { key: '5', label: '5 colors', min: 5, max: 5 },
  { key: '6', label: '6 colors', min: 6, max: 6 },
];
const SP_QTY = [12, 24, 49, 97, 145, 433, 721, 1201, 3001, 6001];
const SP_GRID = [
  [3.72, 5.60, 6.44, 8.91, 10.89, 12.87],
  [2.97, 4.87, 5.94, 7.92, 8.10, 11.88],   // ⚠️ 5-color 8.10 suspected typo (as printed)
  [2.24, 3.56, 4.46, 4.95, 5.45, 5.94],
  [1.81, 2.40, 2.97, 3.14, 3.30, 3.47],
  [1.49, 1.98, 2.48, 2.64, 2.80, 2.97],
  [1.08, 1.74, 2.24, 2.31, 2.40, 2.48],
  [0.92, 1.49, 1.74, 1.90, 2.07, 2.24],
  [0.83, 1.17, 1.57, 1.65, 1.74, 1.82],
  [0.75, 0.90, 1.25, 1.32, 1.41, 1.58],
  [0.60, 0.75, 0.92, 0.99, 1.08, 1.25],
];
const SP_ADDONS = [
  { key: 'poly',       label: 'Polyester / tech (+$0.38)', amount: 0.38, per: 'unit' },
  { key: 'sweatshirt', label: 'Sweatshirt (+$0.38)',       amount: 0.38, per: 'unit' },
  { key: 'metallic',   label: 'Metallic ink (+$0.15)',     amount: 0.15, per: 'unit' },
  { key: 'puff',       label: 'Puff ink (+$0.15)',         amount: 0.15, per: 'unit' },
  { key: 'process',    label: '4-color / simulated process', perQuote: true },
  { key: 'rush',       label: 'Rush', perQuote: true },
];

const DTG_COLS = [
  { key: '4x4',   label: '~4"x4" (small)' },
  { key: '12x12', label: 'up to 12"x12"' },
  { key: '13x17', label: '13"x17"' },
];
const DTG_QTY = [1, 2, 11, 24];
const DTG_GRID = [
  [6.00, 11.00, 13.00],
  [5.75, 10.00, 12.00],
  [5.50, 9.00, 11.00],
  [5.25, 8.00, 10.00],
];

module.exports = {
  printerName: 'Imagewear',
  region: 'East', state: 'NJ',
  sourceFile: 'Imagewear Screen Print + DTG Pricing.pdf', effectiveDate: '2025-07-23',
  notes: 'Cherry Hill NJ. Screen print (qty in PIECES, per location; dark = +1 color '
       + 'underbase + $0.50/pc flash) + DTG (by imprint size, print only). DTG ~4x4 '
       + 'column is inferred; extra DTG locations add manually. ⚠️ 5-color@24-48 ($8.10) suspected typo.',
  groups: [
    {
      id: 'sp_light', method: 'screen_print', label: 'Screen print — light garment',
      selectorDim: 'garment_shade', selectorValue: 'light',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_GRID,
      fees: [{ kind: 'per_color', label: 'Screen', amount: 37.50 }],
      addOns: SP_ADDONS,
      notes: '12-piece minimum. Over 6 colors: add the 5→6 color step per extra color.',
    },
    {
      id: 'sp_dark', method: 'screen_print', label: 'Screen print — dark garment',
      selectorDim: 'garment_shade', selectorValue: 'dark',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_GRID,
      fees: [
        { kind: 'per_color', label: 'Screen (incl. underbase)', amount: 37.50 },
        { kind: 'per_unit',  label: 'Flash', amount: 0.50 },
      ],
      rules: ['dark_underbase_add_color'],
      addOns: SP_ADDONS,
      notes: 'Dark: white underbase adds one color/screen (rule) + $0.50/pc flash.',
    },
    {
      id: 'dtg', method: 'dtg', label: 'DTG (by imprint size)',
      quantityUnit: 'pieces', columnAxis: 'imprint_size', perLocation: false,
      qtyBreaks: DTG_QTY, columns: DTG_COLS, grid: DTG_GRID,
      notes: 'Print only (garment not included), based on ~50% ink coverage. ~4x4 column '
           + 'inferred from the flyer; additional print locations priced separately — add manually.',
    },
  ],
};
