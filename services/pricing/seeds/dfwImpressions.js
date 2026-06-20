// DFW Impressions — seed rate card, from "DFWImpressions.png" (Drive image
// price sheet, read via vision + verified at 2.2x zoom). Irving TX. APPAREL
// DECORATION = screen print + DTF. Qty in PIECES.
//
// ⚠️ The image has bare numeric column headers (1-6) with NO legend, title, or
// fee block. The 1-6 columns are inferred to be INK COLORS for screen print
// (prices scale per color). There are NO setup/screen fees, minimums, embroidery
// or DTG grids, or light/dark split in the source — those are absent, not zero;
// add screen fees from another source if needed. DTF is priced by SIDE COUNT
// (1 side / both sides), not by size or area. Values kept at full precision.

const SP_COLS = [];
for (let i = 1; i <= 6; i++) SP_COLS.push({ key: String(i), label: `${i} color${i > 1 ? 's' : ''}`, min: i, max: i });
const QTY = [12, 25, 51, 101, 201, 501, 1001];

module.exports = {
  printerName: 'DFW Impressions',
  region: 'Mid', state: 'TX',
  sourceFile: 'DFWImpressions.png', effectiveDate: '',
  notes: 'Irving TX. Screen print (cols 1-6 = ink colors, INFERRED) + DTF (by side count). '
       + 'Qty in PIECES. ⚠️ Source image has no setup/screen fees, minimums, or light/dark '
       + 'split — add screen fees separately if the printer charges them.',
  groups: [
    {
      id: 'sp', method: 'screen_print', label: 'Screen print (columns inferred as ink colors)',
      quantityUnit: 'pieces', columnAxis: 'ink_colors', perLocation: true,
      qtyBreaks: QTY, columns: SP_COLS,
      grid: [
        [4.928, 6.776, 8.47, 10.01, 11.55, 13.09],
        [3.388, 4.928, 6.468, 8.008, 9.548, 11.088],
        [2.31, 3.85, 5.005, 6.16, 6.93, 8.47],
        [1.925, 2.75, 3.4375, 4.4, 5.5, 6.1875],
        [1.7875, 2.6125, 3.4375, 4.19375, 4.8125, 5.5],
        [1.375, 2.0625, 2.75, 3.4375, 4.125, 4.8125],
        [1.03125, 1.375, 2.0625, 2.75, 3.4375, 4.125],
      ],
      notes: 'No screen/setup fee in the source image — add manually if charged. No light/dark split shown.',
    },
    {
      id: 'dtf', method: 'dtf', label: 'DTF (by side count)',
      quantityUnit: 'pieces', columnAxis: 'sides', perLocation: false,
      qtyBreaks: QTY,
      columns: [{ key: '1', label: '1 side' }, { key: '2', label: 'Both sides' }],
      grid: [
        [8.00, 14.00],
        [7.60, 13.30],
        [7.22, 12.64],
        [6.86, 12.00],
        [6.52, 11.40],
        [6.19, 10.83],
        [5.88, 10.29],
      ],
      notes: 'Priced by side count (1 side / both sides), not by size or area. Includes application.',
    },
  ],
};
