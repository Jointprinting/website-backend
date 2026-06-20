// Contract-DTG — seed rate card, from "dtg.png" (Drive image price sheet, read
// via vision). Erie PA. APPAREL DECORATION = DTG only. Priced by imprint SIZE ×
// garment SHADE (dark vs white), qty in PIECES; darks cost more (white-ink
// underbase is baked into the dark columns). 301+ pcs = quote. No setup fees.
// (The folder's other image, image(5).png, was blank/unreadable.)

const DTG_COLS = [
  { key: '4x4',   label: '4"x4"' },
  { key: '10x10', label: '10"x10"' },
  { key: '12x12', label: '12"x12"' },
  { key: '12x16', label: '12"x16"' },
  { key: '16x20', label: '16"x20"' },
];
const DTG_QTY = [4, 11, 22, 37, 51, 71, 101, 151, 201, 301];

module.exports = {
  printerName: 'Contract-DTG',
  region: 'East', state: 'PA',
  sourceFile: 'dtg.png', effectiveDate: '2025-05-20',
  notes: 'Erie PA. DTG only, priced by imprint size × garment shade (dark/white). '
       + 'Qty in PIECES. 301+ = quote. Print only (garment not included).',
  groups: [
    {
      id: 'dtg_dark', method: 'dtg', label: 'DTG — dark garment',
      selectorDim: 'garment_shade', selectorValue: 'dark',
      quantityUnit: 'pieces', columnAxis: 'imprint_size', perLocation: true,
      qtyBreaks: DTG_QTY, columns: DTG_COLS,
      grid: [
        [6.60, 7.70, 8.80, 13.20, 18.75],
        [5.50, 7.45, 8.55, 12.15, 17.60],
        [5.25, 6.90, 8.00, 9.90, 15.40],
        [4.95, 6.60, 7.70, 8.80, 14.85],
        [4.70, 6.35, 7.45, 8.55, 14.30],
        [4.15, 5.90, 7.10, 8.00, 11.00],
        [4.00, 5.50, 6.75, 7.45, 10.75],
        [3.85, 5.35, 6.35, 7.00, 9.90],
        [3.75, 5.10, 6.10, 6.55, 8.80],
        [null, null, null, null, null],
      ],
      notes: '301+ pcs = request a quote (null row flags it).',
    },
    {
      id: 'dtg_white', method: 'dtg', label: 'DTG — white garment',
      selectorDim: 'garment_shade', selectorValue: 'white',
      quantityUnit: 'pieces', columnAxis: 'imprint_size', perLocation: true,
      qtyBreaks: DTG_QTY, columns: DTG_COLS,
      grid: [
        [5.50, 6.60, 7.70, 12.15, 16.50],
        [4.70, 6.35, 7.15, 9.90, 14.85],
        [4.40, 5.80, 6.60, 7.70, 13.20],
        [4.20, 5.50, 6.10, 7.15, 12.65],
        [4.00, 5.25, 5.50, 6.90, 12.15],
        [3.75, 4.80, 5.25, 6.60, 9.90],
        [3.55, 4.65, 4.95, 6.35, 9.65],
        [3.40, 4.55, 4.75, 6.10, 8.80],
        [3.30, 4.40, 4.70, 5.80, 8.25],
        [null, null, null, null, null],
      ],
      notes: '301+ pcs = request a quote (null row flags it).',
    },
  ],
};
