// Cole Apparel — seed rate card, from "Screen Printing.pdf" (Drive, 2024 list).
// San Fernando Valley CA. APPAREL DECORATION = screen print (DTG is per-quote
// only in their guide — no grid — so it's not modeled). Screen qty in PIECES,
// per print location, priced by # screens (= # colors), 1-13. Colored / dyed /
// heather garments add one base screen (underbase) — modeled as light vs dark.
// $22 per screen setup. Effective minimum 100 pcs (lowest grid row).

const SP_COLS = [];
for (let i = 1; i <= 13; i++) SP_COLS.push({ key: String(i), label: `${i} color${i > 1 ? 's' : ''}`, min: i, max: i });

const SP_QTY = [100, 150, 250, 350, 500, 750, 1000, 1500, 3000];
const SP_GRID = [
  [2.25, 3.00, 3.75, 4.50, 5.25, 6.00, 6.75, 7.50, 8.25, 9.00, 9.75, 10.50, 11.25],
  [1.90, 2.40, 2.90, 3.50, 4.00, 4.50, 5.25, 5.75, 6.25, 6.75, 7.25, 7.75, 8.25],
  [1.70, 2.00, 2.30, 2.75, 3.00, 3.25, 3.50, 4.00, 4.25, 4.50, 5.00, 5.25, 5.50],
  [1.60, 1.80, 2.00, 2.25, 2.50, 2.75, 3.00, 3.25, 3.50, 3.75, 4.00, 4.25, 4.50],
  [1.50, 1.65, 1.80, 2.00, 2.15, 2.30, 2.45, 2.60, 3.00, 3.00, 3.25, 3.25, 3.50],
  [1.45, 1.55, 1.65, 1.75, 1.85, 2.00, 2.10, 2.20, 2.30, 2.40, 2.50, 2.60, 2.75],
  [1.40, 1.50, 1.50, 1.65, 1.75, 1.85, 1.85, 2.10, 2.10, 2.25, 2.25, 2.50, 2.50],
  [1.40, 1.45, 1.50, 1.55, 1.60, 1.65, 1.70, 1.75, 1.80, 1.90, 1.90, 2.00, 2.00],
  [1.35, 1.40, 1.40, 1.45, 1.50, 1.50, 1.50, 1.60, 1.60, 1.60, 1.75, 1.75, 1.75],
];
const SP_ADDONS = [
  { key: 'fleece',  label: 'Print on fleece (+$0.50)',          amount: 0.50, per: 'unit' },
  { key: 'sleeve',  label: 'Sleeve / leg print (+$0.75)',       amount: 0.75, per: 'unit' },
  { key: 'special', label: 'Special placement (hood/pocket/seam) (+$1.00)', amount: 1.00, per: 'unit' },
  { key: 'oversize', label: 'Oversized print (+$0.25, 1-4 colors)', amount: 0.25, per: 'unit' },
  { key: 'puff',    label: 'Puff ink', perQuote: true },
  { key: 'specialty', label: 'UV / glow / glitter / foil / HD', perQuote: true },
];

module.exports = {
  printerName: 'Cole Apparel',
  region: 'West', state: 'CA',
  sourceFile: 'Cole Apparel Screen Printing.pdf', effectiveDate: '2024-01-01',
  notes: 'San Fernando Valley CA. Screen print only (DTG is per quote — no grid). '
       + 'Priced by # screens/colors (1-13), per location. Colored/heather garments add a '
       + 'base screen (modeled as dark). $22/screen setup. Effective 100-pc minimum.',
  groups: [
    {
      id: 'sp_light', method: 'screen_print', label: 'Screen print — white/natural garment',
      selectorDim: 'garment_shade', selectorValue: 'light',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_GRID,
      fees: [{ kind: 'per_color', label: 'Screen', amount: 22 }],
      addOns: SP_ADDONS,
      notes: 'White/natural garments — no underbase. Effective 100-pc minimum.',
    },
    {
      id: 'sp_dark', method: 'screen_print', label: 'Screen print — colored/heather garment',
      selectorDim: 'garment_shade', selectorValue: 'dark',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: SP_QTY, columns: SP_COLS, grid: SP_GRID,
      fees: [{ kind: 'per_color', label: 'Screen (incl. underbase)', amount: 22 }],
      rules: ['dark_underbase_add_color'],
      addOns: SP_ADDONS,
      notes: 'Colored / dyed / heather garments add one base screen (rule adds a color + screen).',
    },
  ],
};
