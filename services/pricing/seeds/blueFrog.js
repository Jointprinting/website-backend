// Blue Frog ("Platinum" pricing 2025) — seed rate card, from PlatinumPricing2025.pdf
// (Drive; grids verified against a visual render). San Leandro CA. APPAREL
// DECORATION = screen print + embroidery (Blue Frog also does heat transfer —
// a separate size×qty matrix — left out for now; available per quote).
//
// Blue Frog's run charges are a SINGLE price-per-piece by quantity: 3 ink colors
// are included in screen print, and 7,000 stitches in embroidery. We bake the
// documented overages into tier columns so the lookup stays exact:
//   • screen: cols 1-3 = base; 4/5/6 add +$0.30/$0.60/$0.90 per pc (each color over 3).
//   • embroidery: ≤7,000 st = base; each +1,000 st adds +$0.30 per pc.
// Per-location pricing. Flat order minimum $160 (new) / $135 (re-order). 5,000+
// screen pcs and 1,000+ embroidery pcs = "call" (null rows).

const SP_COLS = [
  { key: '1', label: '1 color',  min: 1, max: 1 },
  { key: '2', label: '2 colors', min: 2, max: 2 },
  { key: '3', label: '3 colors', min: 3, max: 3 },
  { key: '4', label: '4 colors', min: 4, max: 4 },
  { key: '5', label: '5 colors', min: 5, max: 5 },
  { key: '6', label: '6 colors', min: 6, max: 6 },
];
const SP_QTY = [75, 100, 250, 500, 1000, 2500, 5000];
const SP_GRID = [
  [2.10, 2.10, 2.10, 2.40, 2.70, 3.00],
  [2.00, 2.00, 2.00, 2.30, 2.60, 2.90],
  [1.70, 1.70, 1.70, 2.00, 2.30, 2.60],
  [1.35, 1.35, 1.35, 1.65, 1.95, 2.25],
  [1.00, 1.00, 1.00, 1.30, 1.60, 1.90],
  [0.90, 0.90, 0.90, 1.20, 1.50, 1.80],
  [null, null, null, null, null, null],
];

const EMB_COLS = [
  { key: '7000',  label: '≤7,000 st',        min: 0,     max: 7000 },
  { key: '8000',  label: '7,001–8,000 st',   min: 7001,  max: 8000 },
  { key: '9000',  label: '8,001–9,000 st',   min: 8001,  max: 9000 },
  { key: '10000', label: '9,001–10,000 st',  min: 9001,  max: 10000 },
  { key: '11000', label: '10,001–11,000 st', min: 10001, max: 11000 },
  { key: '12000', label: '11,001–12,000 st', min: 11001, max: 12000 },
];
const EMB_QTY = [44, 100, 250, 500, 1000];
const EMB_GRID = [
  [3.22, 3.52, 3.82, 4.12, 4.42, 4.72],
  [3.02, 3.32, 3.62, 3.92, 4.22, 4.52],
  [2.72, 3.02, 3.32, 3.62, 3.92, 4.22],
  [2.52, 2.82, 3.12, 3.42, 3.72, 4.02],
  [null, null, null, null, null, null],
];

module.exports = {
  printerName: 'Blue Frog',
  region: 'West', state: 'CA',
  sourceFile: 'PlatinumPricing2025.pdf', effectiveDate: '2025-01-01',
  notes: 'San Leandro CA. Screen print (3 colors incl., +$0.30/pc per color over 3) + '
       + 'embroidery (≤7,000 st incl., +$0.30/pc per 1,000 over). Per location. $160 new / '
       + '$135 re-order flat minimum. Heat transfer available (size×qty matrix) — per quote for now.',
  groups: [
    {
      id: 'sp', method: 'screen_print', label: 'Screen print',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_GRID,
      fees: [{ kind: 'per_color', label: 'Screen', amount: 25 }],
      minOrder: 160,
      addOns: [
        { key: 'poly',       label: 'Poly ink / poly-blend (+$0.50)', amount: 0.50, per: 'unit' },
        { key: 'specialty',  label: 'Reflective / metallic / glow / neon (+$0.70)', amount: 0.70, per: 'unit' },
        { key: 'puff',       label: 'Puff / suede / flock (+$0.70)', amount: 0.70, per: 'unit' },
        { key: 'discharge',  label: 'Discharge / water-based', perQuote: true },
        { key: 'foil',       label: 'Foil printing', perQuote: true },
      ],
      notes: '3 colors included (incl. base white); extra colors baked into the 4-6 columns. '
           + '$160 new / $135 re-order minimum. 5,000+ pcs = call.',
    },
    {
      id: 'emb', method: 'embroidery', label: 'Embroidery',
      quantityUnit: 'pieces', columnAxis: 'stitch_band', perLocation: true,
      qtyBreaks: EMB_QTY, columns: EMB_COLS, grid: EMB_GRID,
      fees: [{ kind: 'digitizing', label: 'Digitizing (≈$20/1,000 st)', amount: 100, estimate: true }],
      minOrder: 160,
      addOns: [
        { key: 'metallic_thread', label: 'Metallic thread (+$0.70/1,000 st)', perQuote: true },
        { key: 'over_20_trims',   label: 'Over 20 trims (+$0.50)', amount: 0.50, per: 'unit' },
        { key: 'appliqu',         label: 'Appliqué', perQuote: true },
      ],
      notes: '≤7,000 stitches + 20 trims included; over-7k baked into the stitch columns. '
           + 'Per location. $160 new / $135 re-order minimum. 1,000+ pcs = call.',
    },
  ],
};
