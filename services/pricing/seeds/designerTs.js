// Designer T's — seed rate card, from "DesignerT's.pdf" (Drive). Wholesale
// price list, eff. 2021-08-01, Brooklawn NJ. APPAREL DECORATION = screen print
// ONLY (the guide has no embroidery or DTF). Screen qty is in PIECES, priced
// per print location. Dark garments: +1 color (white underbase) + $0.25/pc
// flash. 4-color / simulated process, jackets, names/numbers, and rush are
// per-quote (not in the auto-grid).
//
// ⚠️ One source cell is suspect: 1201–3000 @ 2 colors reads $0.61, which breaks
// the otherwise-descending pattern (likely an OCR typo for ~$0.81–0.85).
// Transcribed AS PRINTED — confirm against the original before trusting it.

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
  [2.25, 3.00, 3.90, 5.40, 6.60, 7.80],
  [1.80, 2.95, 3.60, 4.80, 6.00, 7.20],
  [1.35, 2.15, 2.70, 3.00, 3.30, 3.60],
  [1.10, 1.45, 1.80, 1.90, 2.00, 2.10],
  [0.90, 1.20, 1.50, 1.60, 1.70, 1.80],
  [0.65, 1.05, 1.35, 1.40, 1.45, 1.50],
  [0.55, 0.90, 1.05, 1.15, 1.25, 1.35],
  [0.50, 0.61, 0.95, 1.00, 1.05, 1.10],   // ⚠️ 0.61 suspected typo
  [0.45, 0.55, 0.75, 0.80, 0.85, 0.90],
  [0.35, 0.40, 0.52, 0.57, 0.62, 0.67],
];
const SP_ADDONS = [
  { key: 'poly',       label: 'Polyester / tech (+$0.25)', amount: 0.25, per: 'unit' },
  { key: 'sweatshirt', label: 'Sweatshirt (+$0.25)',       amount: 0.25, per: 'unit' },
  { key: 'metallic',   label: 'Metallic ink (+$0.10)',     amount: 0.10, per: 'unit' },
  { key: 'puff',       label: 'Puff ink (+$0.10)',         amount: 0.10, per: 'unit' },
  { key: 'process',    label: '4-color / simulated process', perQuote: true },
  { key: 'rush',       label: 'Rush', perQuote: true },
];

module.exports = {
  printerName: "Designer T's",
  region: 'East', state: 'NJ',
  sourceFile: "DesignerT's.pdf", effectiveDate: '2021-08-01',
  notes: 'Brooklawn NJ. Screen print only (no embroidery/DTF). Screen qty in PIECES, '
       + 'per location. 12-piece minimum. 4-color/simulated process, jackets, '
       + 'names/numbers, and rush are per quote. ⚠️ 1201–3000 @ 2-color cell ($0.61) '
       + 'is a suspected source typo — confirm.',
  groups: [
    {
      id: 'sp_light', method: 'screen_print', label: 'Screen print — light garment',
      selectorDim: 'garment_shade', selectorValue: 'light',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_GRID,
      fees: [{ kind: 'per_color', label: 'Screen', amount: 25 }],
      addOns: SP_ADDONS,
      notes: '12-piece minimum. Over 6 colors: add the per-color step (per quote).',
    },
    {
      id: 'sp_dark', method: 'screen_print', label: 'Screen print — dark garment',
      selectorDim: 'garment_shade', selectorValue: 'dark',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_GRID,
      fees: [
        { kind: 'per_color', label: 'Screen (incl. underbase)', amount: 25 },
        { kind: 'per_unit',  label: 'Flash', amount: 0.25 },
      ],
      rules: ['dark_underbase_add_color'],
      addOns: SP_ADDONS,
      notes: 'Dark garments: white underbase adds one color/screen (rule) + $0.25/pc flash.',
    },
  ],
};
