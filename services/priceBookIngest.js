// services/priceBookIngest.js
//
// A PRINTER'S PRICE LIST, READ IN THE APP.
//
// Getting a price book in used to mean: email the printer's PDF to a Claude
// session, have it hand-write data/printerCatalog-<key>.json, commit it, wait for
// a deploy. That is why 7 of ~16 counterparties have one — not because the others
// don't send price lists, but because each one costs a code change. A printer
// with no price book can never be ranked on cost, so the quoter falls back to
// "nearest", which is not the same question.
//
// This does the reading part in-app. Upload the PDF or a photo of the sheet, get
// back a PROPOSED section in the exact shape the pricing engine reads, plus an
// honest account of what it could not read. It WRITES NOTHING — the owner reviews
// the proposal against the engine and confirms, which goes through the existing
// PUT /api/printers/:key/catalog/:section.
//
// Reuses the machinery that already exists and is already paid for: the same
// Anthropic client shape as services/receiptScanner, the same budget guard
// (services/aiBudget) with its monthly ceiling and daily cap. About half a cent
// a document on Haiku. No new vendor, no new subscription.

const { preflight, recordUsage } = require('./aiBudget');

const MODEL = process.env.PRICEBOOK_MODEL || process.env.RECEIPT_MODEL || 'claude-haiku-4-5';
const MAX_BYTES = 20 * 1024 * 1024;

// The sections the engine knows how to price, and the shape each one must come
// back in. This text is the contract — it is what the extractor is told to
// produce and what validate() checks, so the two can never describe different
// things.
const SECTION_SPECS = {
  screenPrinting: {
    model: 'qty_x_colors',
    describe: `{
  "model": "qty_x_colors",
  "unit": "per_piece_per_location",
  "setup": "included" | "per_screen",
  "setupNote": "<any sentence about setup/screen/film charges, verbatim>",
  "screenFees": { "perScreen": <number> },        // omit entirely when setup is "included"
  "darkAddsUnderbaseColor": <true|false>,          // does a dark garment cost one extra color?
  "colorColumns": ["1","2","3",...],               // the column headers, in order, as strings
  "tiers": [ { "minQty": <number>, "label": "<as printed>", "prices": [<one per colorColumn, same order>] } ]
}`,
  },
  embroidery: {
    model: 'qty_x_stitches',
    describe: `{
  "model": "qty_x_stitches",
  "unit": "per_piece",
  "qtyTiers": [ { "label": "<as printed>", "minQty": <number> } ],
  "stitchBands": ["upto2000","2001-4000",...],     // column headers, in order
  "grid": { "<qtyTier label>": [<one price per stitchBand, same order>] }
}`,
  },
  dtg: {
    model: 'qty_x_colors',
    describe: `{
  "model": "qty_x_colors",
  "unit": "per_piece_per_location",
  "setup": "included" | "per_screen",
  "colorColumns": ["1","2",...],
  "tiers": [ { "minQty": <number>, "label": "<as printed>", "prices": [<one per colorColumn>] } ]
}`,
  },
  dtf: {
    model: 'qty_x_size_sqin',
    describe: `{
  "model": "qty_x_size_sqin",
  "qtyTiers": ["1-11","12-24",...],                // row headers, in order, as strings
  "sizeBandsSqin": [<numbers, ascending>],         // the size columns in square inches
  "grid": { "<qtyTier>": [<one price per sizeBand, same order>] },
  "applyFee": <number|null>                        // per-print application fee if the sheet names one
}`,
  },
};

const SECTIONS = Object.keys(SECTION_SPECS);

function isConfigured() { return !!process.env.ANTHROPIC_API_KEY; }

let _client = null;
function _getClient() {
  if (_client) return _client;
  const Anthropic = require('@anthropic-ai/sdk');   // lazy: the server boots without a key
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 4 });
  return _client;
}

// PURE — exported for tests.
//
// The prompt. Two rules do the real work: a price grid must come back with
// EXACTLY as many prices per row as there are columns (a ragged row is the
// failure mode that produces a price book which silently misprices), and a
// number that isn't legible must come back as null rather than as a guess. A
// wrong price on a quote is worse than a gap the owner fills in.
function buildPrompt(section, printerName) {
  const spec = SECTION_SPECS[section];
  return `You are reading a garment decorator's wholesale price list for ${printerName || 'a printer'}.

Extract ONLY the ${section} pricing into this exact JSON shape:

${spec.describe}

Rules:
- Return ONE JSON object and nothing else. No markdown fence, no commentary.
- Every price row must contain EXACTLY one number per column, in the same order
  as the column headers. If a cell is blank or unreadable, put null in that
  position — never shift the remaining numbers left to fill the gap, and never
  drop the row.
- If a number is not clearly legible, use null. Do not infer, interpolate or
  round to a "sensible" value. A missing price is fixable; a wrong one is not.
- Prices are per piece unless the sheet plainly says otherwise.
- Quantity tiers: minQty is the FIRST quantity the row applies to ("48-59" -> 48).
- Keep the printed labels verbatim so the owner can compare against the sheet.
- If this document has no ${section} pricing at all, return {"model":null,"reason":"<what the document does contain>"}.

Also include a top-level "_notes" array of short strings: anything you could not
read, anything ambiguous, and any surcharge or minimum the grid itself does not
capture.`;
}

// PURE — exported for tests. Pull the JSON object out of a model reply that may
// still have arrived wrapped in prose or a code fence.
function parseReply(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, reason: 'no-json-in-reply' };
  try {
    return { ok: true, value: JSON.parse(body.slice(start, end + 1)) };
  } catch (e) {
    return { ok: false, reason: `unparseable-json: ${e.message}` };
  }
}

// PURE — exported for tests.
//
// Structural validation, BEFORE a human is asked to approve anything. This does
// not check that the prices are right — only the owner can do that — but it does
// catch the shapes the engine cannot read, which would otherwise become a price
// book that silently returns nothing.
//
// Returns { ok, problems[], warnings[], cells, nulls }.
function validate(section, proposed) {
  const problems = [];
  const warnings = [];
  let cells = 0;
  let nulls = 0;

  if (!proposed || typeof proposed !== 'object') {
    return { ok: false, problems: ['nothing was extracted'], warnings, cells, nulls };
  }
  if (proposed.model == null) {
    return {
      ok: false,
      problems: [proposed.reason ? `no ${section} pricing found — ${proposed.reason}` : `no ${section} pricing found in this document`],
      warnings, cells, nulls,
    };
  }
  const spec = SECTION_SPECS[section];
  if (!spec) return { ok: false, problems: [`unknown section "${section}"`], warnings, cells, nulls };
  if (proposed.model !== spec.model) {
    problems.push(`model is "${proposed.model}" but ${section} must be "${spec.model}"`);
  }

  // Every grid shape reduces to "rows of prices against a list of columns".
  const grids = [];
  if (Array.isArray(proposed.tiers)) {
    const cols = Array.isArray(proposed.colorColumns) ? proposed.colorColumns.length : 0;
    if (!cols) problems.push('no colorColumns — the price columns were not read');
    proposed.tiers.forEach((t, i) => {
      grids.push({ label: (t && t.label) || `row ${i + 1}`, prices: t && t.prices, expect: cols });
      if (t && !Number.isFinite(Number(t.minQty))) problems.push(`tier "${(t && t.label) || i + 1}" has no usable minQty`);
    });
    if (!proposed.tiers.length) problems.push('no quantity tiers were read');
  }
  if (proposed.grid && typeof proposed.grid === 'object') {
    const cols = Array.isArray(proposed.stitchBands) ? proposed.stitchBands.length
      : Array.isArray(proposed.sizeBandsSqin) ? proposed.sizeBandsSqin.length : 0;
    if (!cols) problems.push('no column bands — the price columns were not read');
    for (const [label, prices] of Object.entries(proposed.grid)) {
      grids.push({ label, prices, expect: cols });
    }
    if (!Object.keys(proposed.grid).length) problems.push('the price grid is empty');
  }
  if (!grids.length) problems.push('no price rows were found at all');

  // The one that matters: a ragged row means the extractor shifted numbers left
  // to fill a gap, so every price after the gap is attributed to the wrong column.
  for (const g of grids) {
    if (!Array.isArray(g.prices)) { problems.push(`row "${g.label}" has no prices`); continue; }
    if (g.expect && g.prices.length !== g.expect) {
      problems.push(`row "${g.label}" has ${g.prices.length} prices but there are ${g.expect} columns`);
    }
    for (const p of g.prices) {
      cells += 1;
      if (p == null) { nulls += 1; continue; }
      if (!Number.isFinite(Number(p))) problems.push(`row "${g.label}" contains a non-number: ${JSON.stringify(p)}`);
      else if (Number(p) < 0) problems.push(`row "${g.label}" contains a negative price`);
    }
  }

  if (cells && nulls / cells > 0.25) {
    warnings.push(`${nulls} of ${cells} prices could not be read — check the scan before trusting this`);
  } else if (nulls) {
    warnings.push(`${nulls} price${nulls === 1 ? '' : 's'} came back blank and need filling in by hand`);
  }
  for (const n of (Array.isArray(proposed._notes) ? proposed._notes : [])) {
    if (typeof n === 'string' && n.trim()) warnings.push(n.trim());
  }

  return { ok: problems.length === 0, problems, warnings, cells, nulls };
}

// PURE — exported for tests. Strip the transport-only fields before the proposal
// is shown or saved, and stamp the provenance the Printer model already carries.
function shapeForSave(proposed, { capturedOn, source } = {}) {
  const { _notes, reason, ...rest } = proposed || {};
  return {
    ...rest,
    capturedOn: capturedOn || new Date().toISOString().slice(0, 10),
    ...(source ? { source } : {}),
  };
}

// Read one document. Returns { ok, proposed, validation, usage } — and never
// writes. Cost is recorded against the same monthly budget as every other AI
// call in the system.
async function extractSection({ buffer, mime, section, printerName }) {
  if (!isConfigured()) {
    return { ok: false, status: 503, message: 'AI reading is not configured (no ANTHROPIC_API_KEY).' };
  }
  if (!SECTIONS.includes(section)) {
    return { ok: false, status: 400, message: `Section must be one of: ${SECTIONS.join(', ')}.` };
  }
  if (!buffer || !buffer.length) {
    return { ok: false, status: 400, message: 'No file was uploaded.' };
  }
  if (buffer.length > MAX_BYTES) {
    return { ok: false, status: 413, message: 'That file is larger than 20 MB — send the pricing pages only.' };
  }

  const gate = await preflight();
  if (!gate.ok) return { ok: false, status: gate.status, message: gate.message };

  // Same normalization the receipt scanner uses, so a phone photo of a price
  // sheet costs the same as a scan and HEIC/PNG/WebP all work.
  const { toContentBlock } = require('./receiptScanner');
  let block;
  try {
    block = await toContentBlock(buffer, mime);
  } catch (e) {
    return { ok: false, status: 400, message: `Could not read that file: ${e.message}` };
  }

  let msg;
  try {
    msg = await _getClient().messages.create({
      model: MODEL,
      max_tokens: 8000,
      messages: [{ role: 'user', content: [block, { type: 'text', text: buildPrompt(section, printerName) }] }],
    });
  } catch (e) {
    return { ok: false, status: e.status === 429 ? 429 : 502, message: `The reader could not finish: ${e.message}` };
  }

  // Bookkeeping is best-effort — it must never lose work already paid for.
  await recordUsage(msg.usage).catch(() => {});

  const text = (msg.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const parsed = parseReply(text);
  if (!parsed.ok) {
    return { ok: false, status: 422, message: `The reader did not return usable data (${parsed.reason}).` };
  }

  const validation = validate(section, parsed.value);
  return {
    ok: true,
    section,
    proposed: shapeForSave(parsed.value, { source: printerName ? `${printerName} price list` : '' }),
    validation,
    model: MODEL,
    usage: { input: msg.usage?.input_tokens || 0, output: msg.usage?.output_tokens || 0 },
  };
}

module.exports = {
  extractSection, isConfigured, SECTIONS, SECTION_SPECS, MODEL,
  // PURE — exported for tests.
  buildPrompt, parseReply, validate, shapeForSave,
};
