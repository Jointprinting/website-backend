// Structural validation for printer rate-card seeds — catches transcription
// bugs (mismatched grid dimensions, non-ascending quantity breaks, bad column
// ranges, stray non-numeric cells) BEFORE they can reach a customer quote.
//   Run: node scripts/checkRateCards.js
//
// This is intentionally generic: every new printer seed is validated the same
// way, so a copy-paste/transpose slip is caught automatically.

const { SEEDS } = require('../services/pricing');

let problems = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); problems++; };

const VALID_METHODS = ['screen_print', 'embroidery', 'dtg', 'dtf', 'media', 'personalization'];
const VALID_AXES = ['ink_colors', 'stitch_band', 'imprint_size', 'sides', 'none'];

for (const card of SEEDS) {
  if (!card.printerName) fail('a seed has no printerName');
  const ids = new Set();
  for (const g of card.groups || []) {
    const tag = `${card.printerName}/${g.id || '?'}`;
    if (ids.has(g.id)) fail(`${tag}: duplicate group id`);
    ids.add(g.id);
    if (!VALID_METHODS.includes(g.method)) fail(`${tag}: unknown method "${g.method}"`);
    if (!VALID_AXES.includes(g.columnAxis)) fail(`${tag}: unknown columnAxis "${g.columnAxis}"`);
    if (!['pieces', 'dozens'].includes(g.quantityUnit)) fail(`${tag}: unknown quantityUnit "${g.quantityUnit}"`);

    const qb = g.qtyBreaks || [];
    if (qb.length === 0) fail(`${tag}: no qtyBreaks`);
    for (let i = 1; i < qb.length; i++) {
      if (qb[i] <= qb[i - 1]) fail(`${tag}: qtyBreaks not strictly ascending at ${qb[i]}`);
    }

    const grid = g.grid || [];
    if (grid.length !== qb.length) fail(`${tag}: grid has ${grid.length} rows, expected ${qb.length} (one per qty break)`);
    grid.forEach((row, i) => {
      if (!Array.isArray(row) || row.length !== g.columns.length) {
        fail(`${tag}: row ${i} has ${row && row.length} cells, expected ${g.columns.length} (one per column)`);
        return;
      }
      row.forEach((v, j) => {
        if (v !== null && !(typeof v === 'number' && v >= 0)) fail(`${tag}: cell [${i}][${j}] is not a number/null: ${JSON.stringify(v)}`);
      });
    });

    if (g.columnAxis === 'ink_colors' || g.columnAxis === 'stitch_band') {
      g.columns.forEach((c) => {
        if (c.min != null && c.max != null && c.max < c.min) fail(`${tag}: column "${c.key}" has max < min`);
      });
    }
  }
}

const total = SEEDS.reduce((n, c) => n + (c.groups || []).length, 0);
if (problems) {
  console.error(`\n✗ ${problems} problem(s) across ${SEEDS.length} rate card(s).`);
  process.exit(1);
}
console.log(`✓ ${SEEDS.length} rate cards, ${total} pricing groups — all structurally valid.`);
