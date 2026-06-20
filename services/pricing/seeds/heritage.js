// Heritage Screen Printing — seed rate card, transcribed from
// "HSP Pricing Guide 1.1.25" (Drive). Loaded into the DB by services/pricing
// (insert-if-missing on boot); the admin rate-card UI edits the DB copy.
//
// Scope = APPAREL DECORATION only — screen print, embroidery, DTG (and DTF or
// anything else a printer offers, added per-printer). Signs / promos / other
// random products are sourced separately (Distributor Central), NOT here, so
// Heritage's wide-format media pricing is intentionally left out.
//
// Rush fees are omitted (the guide's rush table uses an encoded font and the
// numbers aren't recoverable — Nate will supply them). Polyester upcharge uses
// the flat +25% (the cheaper of the guide's two conflicting descriptions).

const SCREEN_COLS = [
  { key: '1',    label: '1 color',    min: 1, max: 1 },
  { key: '2',    label: '2 colors',   min: 2, max: 2 },
  { key: '3',    label: '3 colors',   min: 3, max: 3 },
  { key: '4-5',  label: '4-5 colors', min: 4, max: 5 },
  { key: '6-8',  label: '6-8 colors', min: 6, max: 8 },
  { key: '9-12', label: '9-12 colors', min: 9, max: 12 },
];
const SCREEN_QTY_DOZ = [1, 2, 3, 4, 6, 12, 24, 36, 48, 96, 200, 500];
const DTG_COLS = [
  { key: '4x4', label: '4"x4"' }, { key: '7x8', label: '7"x8"' },
  { key: '10x12', label: '10"x12"' }, { key: '14x16', label: '14"x16"' },
];
const DTG_QTY = [1, 2, 3, 12, 25];

module.exports = {
  printerName: 'Heritage Screen Printing',
  region: 'East',
  state: 'PA',
  sourceFile: 'HSP Pricing Guide 1.1.25_v2_reducedfile.pdf',
  effectiveDate: '2025-01-01',
  notes: 'Contract decorator, Warminster PA. Apparel decoration only (screen print, '
       + 'embroidery, DTG). Screen-print qty is keyed in DOZENS. Rush fees omitted '
       + '(encoded in source); polyester upcharge set to flat +25%.',
  groups: [
    // ── Screen printing: dark ink on LIGHT garments (no underbase) ──────────
    {
      id: 'sp_light', method: 'screen_print', label: 'Screen print — light garment',
      selectorDim: 'garment_shade', selectorValue: 'light',
      quantityUnit: 'dozens', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SCREEN_QTY_DOZ, columns: SCREEN_COLS,
      grid: [
        [2.95, 3.75, 3.90, 7.10, 9.10, null],
        [2.15, 2.90, 3.20, 5.65, 7.75, null],
        [1.75, 2.35, 2.80, 4.30, 6.30, 8.75],
        [1.55, 2.10, 2.35, 3.55, 5.30, 7.75],
        [1.30, 1.70, 1.85, 2.85, 4.30, 6.25],
        [1.15, 1.25, 1.45, 1.60, 2.35, 4.00],
        [1.00, 1.15, 1.25, 1.35, 1.95, 2.80],
        [0.90, 1.10, 1.20, 1.30, 1.70, 2.70],
        [0.80, 0.95, 1.05, 1.15, 1.60, 2.60],
        [0.75, 0.85, 0.95, 1.05, 1.30, 2.30],
        [0.55, 0.75, 0.85, 1.00, 1.15, 1.85],
        [0.50, 0.60, 0.70, 0.80, 0.90, 1.70],
      ],
      fees: [{ kind: 'per_screen', label: 'Screen', amount: 20 }],
      minOrder: 20,
      addOns: [
        { key: 'poly', label: 'Polyester garment (+25%)', amount: 25, isPercent: true, per: 'unit' },
        { key: 'sleeve', label: 'Sleeve / leg print (+50%)', amount: 50, isPercent: true, per: 'unit' },
        { key: 'pocket', label: 'On/above pocket (+25%)', amount: 25, isPercent: true, per: 'unit' },
        { key: 'specialty_ink', label: 'Specialty ink (metallic/puff/discharge)', perQuote: true },
      ],
      notes: '$20 minimum per print, per color. Dark ink on light garments.',
    },
    // ── Screen printing: light ink on DARK garments (incl. flash + underbase) ─
    {
      id: 'sp_dark', method: 'screen_print', label: 'Screen print — dark garment',
      selectorDim: 'garment_shade', selectorValue: 'dark',
      quantityUnit: 'dozens', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SCREEN_QTY_DOZ, columns: SCREEN_COLS,
      grid: [
        [3.25, 4.10, 4.30, 7.50, 10.25, null],
        [2.40, 3.20, 3.65, 6.25, 8.75, null],
        [2.05, 2.70, 3.25, 4.85, 7.50, 10.00],
        [1.90, 2.40, 2.65, 4.15, 6.00, 8.45],
        [1.55, 2.05, 2.20, 3.35, 4.85, 6.95],
        [1.35, 1.50, 1.65, 1.85, 2.85, 4.50],
        [1.25, 1.35, 1.45, 1.55, 2.15, 3.25],
        [1.15, 1.25, 1.35, 1.50, 2.00, 3.15],
        [0.95, 1.10, 1.20, 1.35, 1.85, 3.05],
        [0.90, 1.05, 1.15, 1.25, 1.50, 2.70],
        [0.65, 0.90, 0.95, 1.00, 1.35, 2.15],
        [0.60, 0.70, 0.80, 0.90, 1.10, 2.00],
      ],
      fees: [{ kind: 'per_screen', label: 'Screen (incl. underbase)', amount: 20 }],
      rules: ['dark_underbase_add_color'],
      minOrder: 20,
      addOns: [
        { key: 'poly', label: 'Polyester garment (+25%)', amount: 25, isPercent: true, per: 'unit' },
        { key: 'sleeve', label: 'Sleeve / leg print (+50%)', amount: 50, isPercent: true, per: 'unit' },
        { key: 'pocket', label: 'On/above pocket (+25%)', amount: 25, isPercent: true, per: 'unit' },
        { key: 'specialty_ink', label: 'Specialty ink (metallic/puff/discharge)', perQuote: true },
      ],
      notes: 'White underbase adds one screen/color (handled by rule). Includes flashing.',
    },
    // ── Embroidery: by stitch-count band, includes up to 15 thread colors ────
    {
      id: 'emb', method: 'embroidery', label: 'Embroidery',
      quantityUnit: 'pieces', columnAxis: 'stitch_band', perLocation: false,
      qtyBreaks: [1, 2, 6, 12, 24, 48, 72, 144, 500],
      columns: [
        { key: '<=2500',      label: 'up to 2,500 st',     min: 0,     max: 2500 },
        { key: '2501-5000',   label: '2,501-5,000 st',     min: 2501,  max: 5000 },
        { key: '5001-7500',   label: '5,001-7,500 st',     min: 5001,  max: 7500 },
        { key: '7501-15000',  label: '7,501-15,000 st',    min: 7501,  max: 15000 },
        { key: '15001-17500', label: '15,001-17,500 st',   min: 15001, max: 17500 },
      ],
      grid: [
        [20.00, 20.00, 20.00, 20.00, 20.00],
        [9.00, 9.00, 9.50, 10.00, 12.50],
        [7.35, 7.60, 7.85, 8.85, 12.00],
        [4.70, 4.85, 5.65, 5.90, 6.75],
        [4.25, 4.35, 4.65, 4.90, 6.25],
        [3.35, 3.75, 4.20, 4.75, 5.25],
        [3.25, 3.45, 3.95, 4.20, 4.60],
        [3.10, 3.20, 3.60, 3.90, 4.35],
        [2.65, 2.85, 3.20, 3.50, 3.75],
      ],
      fees: [{ kind: 'digitizing', label: 'Digitizing (avg — confirm)', amount: 45, estimate: true }],
      minOrder: 20,
      addOns: [
        { key: 'metallic_thread', label: 'Metallic thread (+$0.75/pc)', amount: 0.75, per: 'unit' },
        { key: 'over_17500', label: 'Over 17,500 stitches (+$0.55/1,000)', perQuote: true },
        { key: 'applique', label: 'Applique / tackle twill / 3D puff', perQuote: true },
      ],
      notes: 'Row "1" = $20 single-piece minimum, not a volume price. Up to 15 colors included.',
    },
    // ── DTG: by imprint size, per garment shade ──────────────────────────────
    {
      id: 'dtg_white', method: 'dtg', label: 'DTG — white garment',
      selectorDim: 'garment_shade', selectorValue: 'white',
      quantityUnit: 'pieces', columnAxis: 'imprint_size', perLocation: true,
      qtyBreaks: DTG_QTY, columns: DTG_COLS,
      grid: [
        [20.00, 20.00, 20.00, 20.00],
        [10.00, 10.00, 10.00, 10.00],
        [7.25, 8.00, 9.00, 9.50],
        [4.75, 5.50, 5.75, 6.75],
        [3.75, 4.50, 4.75, 5.75],
      ],
      minOrder: 20,
      notes: 'Rows 1/2 = $20/$10 minimums. CMYK only (no Pantone / neon / metallic).',
    },
    {
      id: 'dtg_black', method: 'dtg', label: 'DTG — black garment',
      selectorDim: 'garment_shade', selectorValue: 'black',
      quantityUnit: 'pieces', columnAxis: 'imprint_size', perLocation: true,
      qtyBreaks: DTG_QTY, columns: DTG_COLS,
      grid: [
        [20.00, 20.00, 20.00, 20.00],
        [10.00, 10.00, 10.00, 10.00],
        [6.50, 7.00, 7.50, 7.75],
        [5.50, 6.00, 7.00, 7.25],
        [4.50, 5.00, 6.50, 7.00],
      ],
      minOrder: 20,
    },
    {
      id: 'dtg_color', method: 'dtg', label: 'DTG — color garment',
      selectorDim: 'garment_shade', selectorValue: 'color',
      quantityUnit: 'pieces', columnAxis: 'imprint_size', perLocation: true,
      qtyBreaks: DTG_QTY, columns: DTG_COLS,
      grid: [
        [20.00, 20.00, 20.00, 20.00],
        [10.00, 10.00, 10.00, 10.00],
        [6.75, 7.50, 7.75, 8.50],
        [5.75, 6.50, 7.50, 7.75],
        [4.75, 5.50, 7.00, 7.50],
      ],
      minOrder: 20,
    },
  ],
};
