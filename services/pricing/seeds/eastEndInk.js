// East End Ink — seed rate card, from "East End Ink PRICE LIST.pdf" (screen) +
// "EEI Embroidery Contract Pricing Sheet.pdf" (Drive). Austin TX. APPAREL
// DECORATION = screen print + embroidery. Both qty in PIECES, per location /
// per logo placement. Effective 12-piece minimum.
//
// Screen print: single grid by # ink colors (1-10); some high-color/low-qty
// cells are NA (null). Dark garments add an underbase SCREEN (~$18.50 setup) —
// per the source this is a setup fee, NOT a per-piece column bump, so it's left
// for manual add rather than modeled as a column shift. Setup is tiered by qty
// ($20 <36 / $18.50 36-599 / $15 600-999 / $10 1000+) — modeled at the common
// $18.50, editable.
//
// Embroidery: two garment-type grids (flats vs bulk), priced by stitch band.
// The bands step +$0.25 per 1,000 stitches, so the grids are generated from the
// ≤5,000-stitch base column. Digitizing/setup tiered by stitch (≈$45), editable.

// ── Screen print ───────────────────────────────────────────────────────────
const SP_COLS = [];
for (let i = 1; i <= 10; i++) SP_COLS.push({ key: String(i), label: `${i} color${i > 1 ? 's' : ''}`, min: i, max: i });
const SP_QTY = [12, 18, 24, 36, 50, 72, 144, 288, 600, 1000, 3000, 5000];
const SP_GRID = [
  [4.59, 5.36, null, null, null, null, null, null, null, null],
  [4.17, 4.85, 5.44, 6.12, null, null, null, null, null, null],
  [3.66, 4.17, 4.59, 5.10, 5.53, 5.95, null, null, null, null],
  [3.06, 3.57, 4.00, 4.42, 4.93, 5.36, 6.12, 6.89, null, null],
  [2.38, 2.98, 3.40, 3.83, 4.34, 4.85, 5.36, 5.95, 6.55, 7.06],
  [1.96, 2.47, 2.72, 3.15, 3.57, 3.83, 4.42, 4.85, 5.10, 5.61],
  [1.53, 1.87, 2.30, 2.72, 3.06, 3.40, 3.83, 4.25, 4.76, 5.19],
  [1.19, 1.53, 1.70, 2.04, 2.30, 2.64, 3.06, 3.40, 3.83, 4.17],
  [1.02, 1.19, 1.45, 1.70, 1.96, 2.04, 2.47, 2.72, 3.06, 3.40],
  [0.94, 1.11, 1.28, 1.53, 1.70, 1.87, 2.04, 2.30, 2.64, 2.89],
  [0.85, 1.02, 1.19, 1.36, 1.53, 1.79, 1.96, 2.13, 2.47, 2.81],
  [0.68, 0.94, 1.11, 1.28, 1.36, 1.70, 1.87, 2.04, 2.38, 2.72],
];

// ── Embroidery (generated: +$0.25 per 1,000 stitches across the bands) ──────
const EMB_COLS = [{ key: '5000', label: '≤5,000 st', min: 0, max: 5000 }];
for (let k = 6; k <= 20; k++) EMB_COLS.push({ key: String(k * 1000), label: `${k - 1},001–${k},000 st`, min: (k - 1) * 1000 + 1, max: k * 1000 });
const EMB_QTY = [12, 24, 72, 144, 288, 576, 1153, 2000];
const STEP = 0.25;
const mkEmbGrid = (base) => base.map((b) => EMB_COLS.map((_, c) => Math.round((b + STEP * c) * 100) / 100));
const EMB_FLATS = mkEmbGrid([6.00, 3.20, 2.75, 2.45, 2.30, 2.20, 2.10, 2.00]);
const EMB_BULK  = mkEmbGrid([6.50, 3.60, 3.05, 2.75, 2.55, 2.45, 2.30, 2.20]);

const EMB_ADDONS = [
  { key: 'over_20k',  label: 'Over 20,000 stitches (+$0.25/1,000)', perQuote: true },
  { key: 'hat_side',  label: 'Hat side logo (+$1.00, aggregate stitches)', amount: 1.00, per: 'unit' },
  { key: 'supplied',  label: 'EEI-supplied goods (20–50% markup)', perQuote: true },
];

module.exports = {
  printerName: 'East End Ink',
  region: 'Mid', state: 'TX',
  sourceFile: 'East End Ink Screen + Embroidery price lists.pdf', effectiveDate: '2022-01-01',
  notes: 'Austin TX. Screen print (by # colors 1-10, single grid) + embroidery (by stitch '
       + 'band, flats vs bulk grids). Per location / per logo placement. 12-pc minimum. Dark '
       + 'screen-print garments add an underbase screen (~$18.50) — add manually.',
  groups: [
    {
      id: 'sp', method: 'screen_print', label: 'Screen print',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_GRID,
      fees: [{ kind: 'per_color', label: 'Screen (≈$18.50, tiered by qty)', amount: 18.50, estimate: true }],
      addOns: [
        { key: 'poly',     label: '100% polyester / wicking (+$0.50)', amount: 0.50, per: 'unit' },
        { key: 'hoodie',   label: 'Hoodie (+$0.40)', amount: 0.40, per: 'unit' },
        { key: 'sweats',   label: 'Crew sweats (+$0.20)', amount: 0.20, per: 'unit' },
        { key: 'sleeve',   label: 'Sleeve / side print (+$0.40)', amount: 0.40, per: 'unit' },
        { key: 'leg',      label: 'Leg / butt print (+$0.50)', amount: 0.50, per: 'unit' },
      ],
      notes: 'Single grid; NA cells = high color count not offered at low qty. Dark garments '
           + 'add a ~$18.50 underbase screen (add manually — source treats it as a setup fee).',
    },
    {
      id: 'emb_flats', method: 'embroidery', label: 'Embroidery — hats / small flats',
      selectorDim: 'product', selectorValue: 'flats',
      quantityUnit: 'pieces', columnAxis: 'stitch_band', perLocation: true,
      qtyBreaks: EMB_QTY, columns: EMB_COLS, grid: EMB_FLATS,
      fees: [{ kind: 'digitizing', label: 'Setup w/ sample (≈$45, tiered by stitch)', amount: 45, estimate: true }],
      addOns: EMB_ADDONS,
      notes: 'Polos, tees, button-downs, light jackets, bandanas. Per logo placement. Over 20k st = +$0.25/1,000.',
    },
    {
      id: 'emb_bulk', method: 'embroidery', label: 'Embroidery — bulk items',
      selectorDim: 'product', selectorValue: 'bulk',
      quantityUnit: 'pieces', columnAxis: 'stitch_band', perLocation: true,
      qtyBreaks: EMB_QTY, columns: EMB_COLS, grid: EMB_BULK,
      fees: [{ kind: 'digitizing', label: 'Setup w/ sample (≈$45, tiered by stitch)', amount: 45, estimate: true }],
      addOns: EMB_ADDONS,
      notes: 'Heavy jackets, coats, towels, robes, blankets, hoodies, large bags. Per logo placement.',
    },
  ],
};
