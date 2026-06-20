// Ace Screen Printing — seed rate card, from "Screen ... Contract List 2025.pdf"
// + "Embroidery Wholesale Contract List 2025.pdf" (Drive). Glassboro NJ.
// APPAREL DECORATION = screen print + embroidery. Screen qty in PIECES, per
// print location; embroidery qty in DOZENS, by stitch band. Dark garments add
// a flat +$0.30/pc (Ace's only stated dark adder — no automatic color bump).
// 5,000+ pieces = "call" (null cells flag a manual quote).
//
// ⚠️ Suspected source typos, transcribed AS PRINTED — confirm against originals:
//   • embroidery 10,000-stitch @ 7–12 doz reads $7.90 (breaks the progression)
//   • the 4,000-stitch row dips below the 3,000-stitch row in the first columns
// ⚠️ The screen file is named "Retail" yet is the only screen grid present —
//   confirm these are your CONTRACT rates (not retail) before trusting margins.

const SP_COLS = [
  { key: '1', label: '1 color',  min: 1, max: 1 },
  { key: '2', label: '2 colors', min: 2, max: 2 },
  { key: '3', label: '3 colors', min: 3, max: 3 },
  { key: '4', label: '4 colors', min: 4, max: 4 },
  { key: '5', label: '5 colors', min: 5, max: 5 },
  { key: '6', label: '6 colors', min: 6, max: 6 },
];
const SP_QTY = [1, 12, 24, 48, 72, 144, 240, 360, 500, 1200, 2500, 5000];
const SP_GRID = [
  [7.50, 10.50, 12.00, 15.00, 16.50, 18.00],
  [4.13, 4.95, 5.94, 7.13, 8.55, 10.26],
  [3.83, 4.59, 5.51, 6.61, 7.93, 9.52],
  [3.38, 4.05, 4.86, 5.83, 7.00, 8.40],
  [3.00, 3.54, 4.18, 4.93, 5.82, 6.86],
  [2.63, 3.10, 3.66, 4.31, 5.09, 6.01],
  [2.25, 2.66, 3.13, 3.70, 4.36, 5.15],
  [1.88, 2.16, 2.48, 2.85, 3.28, 3.77],
  [1.50, 1.65, 1.82, 2.00, 2.20, 2.42],
  [1.43, 1.52, 1.63, 1.75, 1.87, 2.00],
  [1.35, 1.42, 1.49, 1.56, 1.64, 1.72],
  [null, null, null, null, null, null],   // 5,000+ = call
];
const SP_ADDONS = [
  { key: 'caps',       label: 'Caps (+$0.20)',        amount: 0.20, per: 'unit' },
  { key: 'sweats',     label: 'Sweats (+$0.20)',      amount: 0.20, per: 'unit' },
  { key: 'jackets',    label: 'Jackets (+$2.00)',     amount: 2.00, per: 'unit' },
  { key: 'mesh',       label: 'Nylon / mesh jersey (+$0.50)', amount: 0.50, per: 'unit' },
  { key: 'glitter',    label: 'Metallic / puff / glitter (+$0.30)', amount: 0.30, per: 'unit' },
  { key: 'reflective', label: 'Reflective ink (+$2.00)', amount: 2.00, per: 'unit' },
  { key: 'specialty',  label: 'Crystalline / fluorescent ink', perQuote: true },
];

const EMB_COLS = [
  { key: '3000',  label: '≤3,000 st',        min: 0,     max: 3000 },
  { key: '4000',  label: '3,001–4,000 st',   min: 3001,  max: 4000 },
  { key: '5000',  label: '4,001–5,000 st',   min: 4001,  max: 5000 },
  { key: '6000',  label: '5,001–6,000 st',   min: 5001,  max: 6000 },
  { key: '7000',  label: '6,001–7,000 st',   min: 6001,  max: 7000 },
  { key: '8000',  label: '7,001–8,000 st',   min: 7001,  max: 8000 },
  { key: '9000',  label: '8,001–9,000 st',   min: 8001,  max: 9000 },
  { key: '10000', label: '9,001–10,000 st',  min: 9001,  max: 10000 },
  { key: '11000', label: '10,001–11,000 st', min: 10001, max: 11000 },
  { key: '12000', label: '11,001–12,000 st', min: 11001, max: 12000 },
  { key: '13000', label: '12,001–13,000 st', min: 12001, max: 13000 },
  { key: '14000', label: '13,001–14,000 st', min: 13001, max: 14000 },
  { key: '15000', label: '14,001–15,000 st', min: 14001, max: 15000 },
  { key: '16000', label: '15,001–16,000 st', min: 15001, max: 16000 },
  { key: '17000', label: '16,001–17,000 st', min: 16001, max: 17000 },
];
const EMB_QTY = [1, 7, 13, 25, 49, 73, 145, 289];   // dozens
// rows = qty (dozens) breaks, columns = stitch band (transposed from source).
const EMB_GRID = [
  [5.66, 5.18, 5.73, 6.29, 6.85, 7.40, 7.96, 8.51, 9.07, 9.62, 10.18, 10.74, 11.29, 11.85, 12.40],
  [4.53, 3.75, 4.31, 4.86, 5.42, 5.97, 6.53, 7.90, 7.64, 8.20, 8.75, 9.31, 9.87, 10.42, 10.98],
  [3.27, 3.59, 3.70, 4.14, 4.70, 5.26, 5.82, 6.37, 6.93, 7.48, 8.04, 8.60, 9.15, 9.71, 10.26],
  [2.35, 2.68, 3.24, 3.79, 4.35, 4.90, 5.46, 6.02, 6.57, 7.13, 7.68, 8.24, 8.79, 9.35, 9.90],
  [2.15, 2.56, 3.12, 3.67, 4.23, 4.78, 5.34, 5.90, 6.45, 7.01, 7.56, 8.12, 8.68, 9.23, 9.79],
  [1.99, 2.44, 3.00, 3.55, 4.11, 4.67, 5.22, 5.78, 6.33, 6.89, 7.44, 8.00, 8.56, 9.11, 9.67],
  [1.83, 2.38, 2.94, 3.49, 4.05, 4.61, 5.16, 5.72, 6.27, 6.83, 7.39, 7.94, 8.50, 9.05, 9.61],
  [1.80, 2.35, 2.91, 3.46, 4.02, 4.58, 5.13, 5.69, 6.24, 6.80, 7.36, 7.91, 8.47, 9.02, 9.58],
];

module.exports = {
  printerName: 'Ace Screen Printing',
  region: 'East', state: 'NJ',
  sourceFile: 'Screen / Embroidery Contract List 2025.pdf', effectiveDate: '2025-01-01',
  notes: 'Glassboro NJ. Screen print (qty in PIECES, per location) + embroidery '
       + '(qty in DOZENS, by stitch band). Darks: +$0.30/pc. 5,000+ pcs = call. '
       + '⚠️ Confirm screen list is CONTRACT (not retail); two embroidery cells look like typos.',
  groups: [
    {
      id: 'sp_light', method: 'screen_print', label: 'Screen print — light garment',
      selectorDim: 'garment_shade', selectorValue: 'light',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_GRID,
      fees: [{ kind: 'per_color', label: 'Screen', amount: 15 }],
      addOns: SP_ADDONS,
      notes: '5,000+ pcs = manual quote (null row). Underbase counts as a screen for setup.',
    },
    {
      id: 'sp_dark', method: 'screen_print', label: 'Screen print — dark garment',
      selectorDim: 'garment_shade', selectorValue: 'dark',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_GRID,
      fees: [{ kind: 'per_color', label: 'Screen', amount: 15 }, { kind: 'per_unit', label: 'Dark-garment uplift', amount: 0.30 }],
      addOns: SP_ADDONS,
      notes: 'Dark = flat +$0.30/pc (Ace\'s only stated dark adder). A white underbase, '
           + 'if the art needs one, adds a screen — add it manually.',
    },
    {
      id: 'emb', method: 'embroidery', label: 'Embroidery',
      quantityUnit: 'dozens', columnAxis: 'stitch_band', perLocation: false,
      qtyBreaks: EMB_QTY, columns: EMB_COLS, grid: EMB_GRID,
      fees: [{ kind: 'digitizing', label: 'Digitizing (≈ $7.50/1,000 st, $30 min)', amount: 30, estimate: true }],
      addOns: [
        { key: 'name_1line', label: 'Personalization — 1 line (+$7)',  amount: 7,  per: 'unit' },
        { key: 'name_2line', label: 'Personalization — 2 lines (+$10)', amount: 10, per: 'unit' },
        { key: 'over_17000', label: 'Over 17,000 stitches (+$0.50/1,000)', perQuote: true },
      ],
      notes: 'Qty in DOZENS. Stitch count rounds up to the next 1,000 band. Thread colors '
           + 'assumed included. Over 17,000 st = +$0.50/1,000 (manual). Personalization needs 12+ pcs.',
    },
  ],
};
