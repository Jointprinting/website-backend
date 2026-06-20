// Apollo USA — seed rate card, from "2025 Embroidery.pdf" (master) + "2025
// Screen Print.pdf" (Drive). Pennsauken NJ (filed under "West", but actually NJ
// — the closest of the Mid/West printers to JP's clients). Net/contract pricing.
// APPAREL DECORATION = screen print + embroidery + DTF (size-tier). Screen qty
// in PIECES, per location, single grid (no light/dark split, no auto-underbase
// rule published). Embroidery qty in PIECES by stitch band. DTF priced by SIZE
// tier (NOT per area). Min 48 pcs on everything.
//
// ⚠️ Screen qty break at 720 overlaps in the source (433-720 / 720-2000); the
// engine snaps 720 to the 720-2000 row. DTF over 5x5 adds +$1/inch (manual).

const SP_COLS = [
  { key: '1', label: '1 color',  min: 1, max: 1 },
  { key: '2', label: '2 colors', min: 2, max: 2 },
  { key: '3', label: '3 colors', min: 3, max: 3 },
  { key: '4', label: '4 colors', min: 4, max: 4 },
  { key: '5', label: '5 colors', min: 5, max: 5 },
  { key: '6', label: '6 colors', min: 6, max: 6 },
];
const SP_QTY = [48, 145, 433, 720, 2001];
const SP_GRID = [
  [2.86, 3.77, 4.61, 5.19, 5.75, 6.32],
  [2.45, 2.94, 3.43, 3.89, 4.35, 5.32],
  [2.21, 2.73, 3.25, 3.84, 4.23, 4.86],
  [1.99, 2.54, 3.05, 3.58, 3.89, 4.42],
  [1.80, 1.99, 2.18, 2.79, 3.25, 3.58],
];

const EMB_COLS = [
  { key: '5000', label: '≤5,000 st',       min: 0,    max: 5000 },
  { key: '6000', label: '5,001–6,000 st',  min: 5001, max: 6000 },
  { key: '7000', label: '6,001–7,000 st',  min: 6001, max: 7000 },
  { key: '8000', label: '7,001–8,000 st',  min: 7001, max: 8000 },
  { key: '9000', label: '8,001–9,000 st',  min: 8001, max: 9000 },
];
const EMB_QTY = [48, 145, 577, 1009];
const EMB_GRID = [
  [4.50, 4.75, 5.00, 5.25, 5.50],
  [3.55, 3.80, 4.05, 4.30, 4.55],
  [3.25, 3.50, 3.75, 4.00, 4.25],
  [2.95, 3.20, 3.45, 3.70, 3.95],
];

const DTF_COLS = [
  { key: '3x3', label: '3"x3"' },
  { key: '4x4', label: '4"x4"' },
  { key: '5x5', label: '5"x5"' },
];
const DTF_QTY = [48, 145, 577];
const DTF_GRID = [
  [4.50, 5.00, 5.50],
  [3.50, 4.00, 4.50],
  [3.35, 3.75, 4.25],
];

module.exports = {
  printerName: 'Apollo USA',
  region: 'West', state: 'NJ',
  sourceFile: 'Apollo 2025 Screen Print + Embroidery.pdf', effectiveDate: '2025-01-01',
  notes: 'Pennsauken NJ. Net/contract pricing. Screen print (PIECES, per location, single '
       + 'grid) + embroidery (PIECES, by stitch band) + DTF (by size tier). Min 48 pcs.',
  groups: [
    {
      id: 'sp', method: 'screen_print', label: 'Screen print',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_GRID,
      fees: [{ kind: 'per_color', label: 'Screen', amount: 25 }],
      minOrder: 0,
      addOns: [
        { key: 'poly',       label: 'Polyester / tech (+$0.25)', amount: 0.25, per: 'unit' },
        { key: 'sweatshirt', label: 'Sweatshirt (+$0.50)',       amount: 0.50, per: 'unit' },
        { key: 'metallic',   label: 'Metallic ink (+$1.00)',     amount: 1.00, per: 'unit' },
        { key: 'reflective', label: 'Reflective ink (+$0.75, needs underbase)', amount: 0.75, per: 'unit' },
      ],
      notes: '48-piece minimum. No published dark-garment underbase auto-add (only reflective needs one).',
    },
    {
      id: 'emb', method: 'embroidery', label: 'Embroidery',
      quantityUnit: 'pieces', columnAxis: 'stitch_band', perLocation: false,
      qtyBreaks: EMB_QTY, columns: EMB_COLS, grid: EMB_GRID,
      fees: [{ kind: 'digitizing', label: 'Digitizing (≈$10/1,000 st, $50 min)', amount: 50, estimate: true }],
      minOrder: 0,
      addOns: [
        { key: 'puff',       label: '3D / puff (+$1.50)', amount: 1.50, per: 'unit' },
        { key: 'over_9000',  label: 'Over 9,000 stitches (+$0.35/1,000)', perQuote: true },
        { key: 'add_location', label: 'Additional location (+$2.50, ≤5k st)', amount: 2.50, per: 'unit' },
      ],
      notes: 'Qty in PIECES. Over 9,000 st = +$0.35/1,000 (manual). 48-pc minimum.',
    },
    {
      id: 'dtf', method: 'dtf', label: 'DTF / heat transfer (by size)',
      quantityUnit: 'pieces', columnAxis: 'imprint_size', perLocation: true,
      qtyBreaks: DTF_QTY, columns: DTF_COLS, grid: DTF_GRID,
      fees: [{ kind: 'flat', label: 'Setup', amount: 50 }],
      minOrder: 0,
      addOns: [{ key: 'oversize', label: 'Larger than 5x5 (+$1/inch)', perQuote: true }],
      notes: 'Priced by transfer SIZE (not area). Over 5x5 = +$1/inch (manual). Price includes pressing. 48-pc min.',
    },
  ],
};
