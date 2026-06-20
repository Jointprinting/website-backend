// Oklahoma Ink — seed rate card, from "Direct Print Pricing.pdf" (Drive; grid
// is image-only, read via vision + triple-checked). Tulsa OK. APPAREL
// DECORATION = screen print only. Qty in PIECES, per location, by # ink colors
// (1-7). Single grid; dark garments add a white underbase (+1 color/screen).
// Screens are $15/color/location but FREE over 100 pcs. Over 1,200 pcs = call.

const SP_COLS = [];
for (let i = 1; i <= 7; i++) SP_COLS.push({ key: String(i), label: `${i} color${i > 1 ? 's' : ''}`, min: i, max: i });
const SP_QTY = [1, 12, 50, 100, 250, 500];
const SP_GRID = [
  [4.30, 6.05, 7.65, 9.35, 11.00, 12.65, 14.25],
  [2.80, 3.40, 3.90, 4.50, 4.95, 5.50, 6.05],
  [1.25, 1.80, 2.30, 2.80, 3.30, 3.75, 4.20],
  [1.05, 1.35, 1.90, 2.35, 2.65, 3.10, 3.55],
  [0.90, 1.25, 1.65, 2.15, 2.55, 3.00, 3.45],
  [0.80, 1.20, 1.55, 2.00, 2.40, 2.85, 3.30],
];
const SP_ADDONS = [
  { key: 'pocket', label: 'On pocket / sleeve / leg (+$0.25)', amount: 0.25, per: 'unit' },
  { key: 'above_pocket', label: 'Above pocket (+$0.10)', amount: 0.10, per: 'unit' },
  { key: 'pms',    label: 'PMS color match (non-stock)', perQuote: true },
];

module.exports = {
  printerName: 'Oklahoma Ink',
  region: 'Mid', state: 'OK',
  sourceFile: 'Direct Print Pricing.pdf', effectiveDate: '2025-09-01',
  notes: 'Tulsa OK. Screen print only, by # colors (1-7), per location. Single grid; dark = '
       + '+1 underbase color. Screens $15/color but FREE over 100 pcs. Over 1,200 pcs = call.',
  groups: [
    {
      id: 'sp_light', method: 'screen_print', label: 'Screen print — light garment',
      selectorDim: 'garment_shade', selectorValue: 'light',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_GRID,
      fees: [{ kind: 'per_color', label: 'Screen (free over 100 pcs)', amount: 15, waiveOverQty: 100 }],
      addOns: SP_ADDONS,
      notes: 'Stock colors. Over 1,200 pcs = call for quote.',
    },
    {
      id: 'sp_dark', method: 'screen_print', label: 'Screen print — dark garment',
      selectorDim: 'garment_shade', selectorValue: 'dark',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_GRID,
      fees: [{ kind: 'per_color', label: 'Screen incl. underbase (free over 100 pcs)', amount: 15, waiveOverQty: 100 }],
      rules: ['dark_underbase_add_color'],
      addOns: SP_ADDONS,
      notes: 'Underbase charged as one additional color on dark garments (rule adds a color + screen).',
    },
  ],
};
