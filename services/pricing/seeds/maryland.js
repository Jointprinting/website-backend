// Maryland Print House — seed rate card, from "Contract Pricing 2023.pdf"
// (Drive). Hampstead MD. APPAREL DECORATION = DTF + (screen print, embroidery).
//
// Only DTF is seeded here: it extracted cleanly and is priced by AREA — a
// $/sq-in rate by quantity band, per print location, plus a flat heat-press
// charge. The screen-print and embroidery grids in the same PDF came back
// OCR-scrambled (cells couldn't be placed deterministically), so they're left
// OUT pending a clean visual transcription rather than guessed.

module.exports = {
  printerName: 'Maryland Print House',
  region: 'East', state: 'MD',
  sourceFile: 'Contract Pricing 2023.pdf', effectiveDate: '2023-02-01',
  notes: 'Hampstead MD. DTF = $/sq-in by qty band, per location, + $1.50/pc heat '
       + 'press, $2.50/location min. Screen print + embroidery exist in the source '
       + 'but need a clean visual transcription (PDF text was scrambled) — not yet loaded.',
  groups: [
    {
      id: 'dtf', method: 'dtf', label: 'DTF transfer (priced by area)',
      quantityUnit: 'pieces', columnAxis: 'none', perLocation: true, areaPriced: true,
      qtyBreaks: [1, 12, 24],
      columns: [{ key: 'rate', label: '$/sq in' }],
      grid: [[0.09], [0.06], [0.03]],
      fees: [{ kind: 'per_unit', label: 'Heat press / application', amount: 1.50 }],
      minOrder: 2.50,
      addOns: [
        { key: 'names',     label: 'Heat-pressed name / number (+$5 ea)', amount: 5, per: 'unit' },
        { key: 'rush_1wk',  label: 'Rush — 1 week (+25%)', amount: 25, isPercent: true, per: 'unit' },
        { key: 'rush_3day', label: 'Rush — 3 day (+50%)',  amount: 50, isPercent: true, per: 'unit' },
      ],
      notes: 'Enter the design AREA (sq in). Charge = rate x area x pieces + $1.50/pc press. '
           + '$2.50/location minimum. Qty bands 1-11 / 12-23 / 24+.',
    },
  ],
};
