// services/receiptScanner.js
//
// Reads a paid receipt/invoice and pulls out the fields the ledger needs
// (vendor, amount, date, order #, category, line items) using Claude. Built for
// a solo operator who wants it automated but cheap and in his control:
//
//   • CHEAP  — uses Haiku 4.5 (the least expensive model, plenty for reading a
//              receipt). ~half a cent per receipt. Model is env-overridable.
//   • SAFE   — the original file is uploaded to R2 *before* any AI call, so a
//              cost is never lost even if the read fails or is rate-limited.
//   • RESILIENT — a durable queue processes receipts one at a time. On a rate
//              limit it reads the API's `retry-after`, pauses exactly that long,
//              then resumes — nothing is dropped, nothing is double-charged.
//              Pending receipts are re-picked-up on boot.
//   • ANY FILE — PDFs go in as document blocks; photos (incl. iPhone HEIC) are
//              normalized to JPEG via sharp; oversized images are downscaled to
//              keep token cost (and the bill) low.
//
// Feature-flagged on ANTHROPIC_API_KEY: with no key the queue simply parks
// receipts as `pending` and the UI lets Nate hand-enter — nothing breaks.

const Receipt = require('../models/Receipt');

// Expense buckets a paid receipt can map to (Nate's real categories, minus the
// income/equity ones — a receipt he paid is always a cost).
const EXPENSE_CATEGORIES = [
  'Blank COGS', 'Printer COGS', 'Shipping', 'Art', 'Commission',
  'Software', 'Sales Tax', 'Other',
];

const MODEL = process.env.RECEIPT_MODEL || 'claude-haiku-4-5';
const MAX_ATTEMPTS = 3;
const MAX_IMAGE_EDGE = 1568;   // Anthropic's recommended max long edge — caps tokens/cost
const PDF_LIMIT = 30 * 1024 * 1024;

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

let _client = null;
function _getClient() {
  if (_client) return _client;
  const Anthropic = require('@anthropic-ai/sdk'); // lazy: server boots without a key
  // maxRetries lets the SDK ride out *transient* 429/5xx itself (honoring
  // retry-after); the durable queue below handles long rate-limit windows.
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 4 });
  return _client;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (e) => e && (e.status === 429 || e.name === 'RateLimitError');
const isOverloaded = (e) => e && (e.status === 529 || e.status === 503);

// How long to wait after a rate limit: honor the API's retry-after header
// (seconds), else default to 60s.
function retryAfterMs(e) {
  const h = e && e.headers && (e.headers['retry-after'] || e.headers.get?.('retry-after'));
  const secs = Number(h);
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs, 3600) * 1000;
  return 60 * 1000;
}

// ── file → a Claude content block ───────────────────────────────────────────
// PDFs become a document block; everything image-ish is normalized to JPEG
// (handles HEIC, PNG, WebP, etc.) and downscaled so we never pay for a 12MP
// phone photo when a 1568px image reads identically.
async function toContentBlock(buffer, mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'application/pdf') {
    if (buffer.length > PDF_LIMIT) throw new Error('PDF too large to read (over 30 MB).');
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  }
  // Treat anything else as an image we can normalize.
  const sharp = require('sharp');
  const jpeg = await sharp(buffer, { failOn: 'none' })
    .rotate()                                   // respect EXIF orientation
    .resize({ width: MAX_IMAGE_EDGE, height: MAX_IMAGE_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } };
}

// The single tool we force Claude to call — guarantees clean structured output
// (no brittle JSON-in-prose parsing).
const RECORD_TOOL = {
  name: 'record_receipt',
  description: 'Record the structured data read from a single paid receipt or supplier invoice.',
  input_schema: {
    type: 'object',
    properties: {
      vendor:      { type: 'string', description: 'The business that was paid (the supplier/printer/shipper).' },
      date:        { type: 'string', description: 'Receipt/invoice date as YYYY-MM-DD. Empty string if none is printed.' },
      amount:      { type: 'number', description: 'The TOTAL amount charged (grand total incl. tax & shipping).' },
      currency:    { type: 'string', description: 'ISO currency code, default USD.' },
      orderNumber: { type: 'string', description: 'Any PO / order / job number printed on it (digits only ok). Empty if none.' },
      category:    { type: 'string', enum: EXPENSE_CATEGORIES, description: 'Best-fit expense category.' },
      subtotal:    { type: ['number', 'null'], description: 'Subtotal before tax/shipping, if shown.' },
      tax:         { type: ['number', 'null'], description: 'Tax amount, if shown.' },
      shipping:    { type: ['number', 'null'], description: 'Shipping/freight amount, if shown.' },
      lineItems: {
        type: 'array',
        description: 'Individual line items, if legible.',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            qty:         { type: ['number', 'null'] },
            unitPrice:   { type: ['number', 'null'] },
            amount:      { type: ['number', 'null'] },
          },
        },
      },
      summary:    { type: 'string', description: 'One short human-readable line, e.g. "Heritage — 48 tees, screen print".' },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Overall confidence in the read.' },
      flags:      { type: 'array', items: { type: 'string' }, description: 'Anything unclear or worth a human check (e.g. "total smudged", "no date").' },
    },
    required: ['vendor', 'amount', 'category', 'confidence'],
  },
};

const SYSTEM = [
  'You read paid receipts and supplier invoices for a small merch/screen-print broker and extract structured data.',
  'Rules:',
  '- The TOTAL is the grand total actually charged (after tax and shipping). Do not return a subtotal as the amount.',
  '- Dates are timeline info — capture the receipt/invoice date exactly as printed (convert to YYYY-MM-DD).',
  '- VENDOR: a folder name is often supplied with the receipt — it is almost always the vendor/supplier. Use it as the vendor whenever the receipt itself does not clearly name the merchant (card, bank, and Zelle payment confirmations usually do not). Never return "Unknown"/"N/A" when a folder name was given.',
  '- NEVER refuse, and do not judge whether a purchase looks "business" or "personal" — always extract the data. The owner decides how to categorize it.',
  '- Category guidance: blank garments (S&S, SanMar, Alphabroder) → "Blank COGS"; contract printing/embroidery/decorating/patches → "Printer COGS"; parcel/freight shipping (UPS, USPS, FedEx, ArcBest) → "Shipping"; digitizing/vectoring/art fees → "Art"; sales commissions → "Commission"; software/SaaS (Render, Google, Notion, Anthropic, OpenAI, Cloudflare, Adobe) → "Software"; sales tax / state revenue → "Sales Tax"; travel/tolls/misc (Amtrak, NJ Transit, ParkMobile) and anything else → "Other".',
  '- Only the vendor may be inferred from the folder; if another field is not present, leave it empty/null and add a flag rather than guessing.',
  '- Always call the record_receipt tool exactly once.',
].join('\n');

// Read one receipt → structured data. Throws RateLimitError (status 429) up to
// the caller so the queue can pause; the SDK already retried transient cases.
async function extract(buffer, mime, folderHint = '') {
  const block = await toContentBlock(buffer, mime);
  const folderLine = folderHint
    ? `This receipt was filed in a folder named "${folderHint}", which is almost always the vendor — use it as the vendor unless the receipt itself clearly names a different company. `
    : '';
  const msg = await _getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM,
    tools: [RECORD_TOOL],
    tool_choice: { type: 'tool', name: 'record_receipt' },
    messages: [{
      role: 'user',
      content: [block, { type: 'text', text: `${folderLine}Read this receipt and record its data with record_receipt.` }],
    }],
  });
  const tool = (msg.content || []).find((b) => b.type === 'tool_use');
  if (!tool) throw new Error('Model did not return structured receipt data.');
  return { data: tool.input || {}, usage: msg.usage || null };
}

// Map the raw tool output onto the Receipt.extracted shape (parse the date,
// coerce numbers, clamp the category to a known bucket).
function mapExtracted(d) {
  const n = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  let date = null;
  if (d.date) { const dt = new Date(d.date); if (!isNaN(dt.getTime())) date = dt; }
  const category = EXPENSE_CATEGORIES.includes(d.category) ? d.category : 'Other';
  return {
    vendor: (d.vendor || '').trim(),
    date,
    amount: n(d.amount),
    currency: (d.currency || 'USD').toUpperCase(),
    orderNumber: String(d.orderNumber || '').trim(),
    category,
    subtotal: n(d.subtotal),
    tax: n(d.tax),
    shipping: n(d.shipping),
    lineItems: Array.isArray(d.lineItems) ? d.lineItems.map((li) => ({
      description: (li.description || '').trim(), qty: n(li.qty), unitPrice: n(li.unitPrice), amount: n(li.amount),
    })) : [],
    summary: (d.summary || '').trim(),
  };
}

// ── durable queue ───────────────────────────────────────────────────────────
const _queue = [];
let _running = false;
let _paused = false;

function enqueue(id) {
  const s = String(id);
  if (!_queue.includes(s)) _queue.push(s);
  _kick();
}

function _kick() {
  if (_running || _paused) return;
  if (!isConfigured()) return;       // no key → leave everything pending
  if (_queue.length === 0) return;
  _running = true;
  setImmediate(_loop);
}

async function _download(url) {
  const axios = require('axios');
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  return Buffer.from(res.data);
}

async function _processOne(id) {
  const r = await Receipt.findById(id);
  if (!r || r.status === 'booked' || r.status === 'ignored') return;
  r.status = 'processing';
  r.attempts = (r.attempts || 0) + 1;
  await r.save();

  let buffer;
  try {
    buffer = await _download(r.fileUrl);
  } catch (e) {
    r.extractionError = `Could not fetch the stored file: ${e.message}`;
    r.status = r.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    await r.save();
    if (r.status === 'pending') setTimeout(() => enqueue(id), 10000);
    return;
  }

  try {
    const { data, usage } = await extract(buffer, r.fileMime, r.folderHint);
    r.extracted = mapExtracted(data);
    // The folder is the most reliable vendor signal — fall back to it (and
    // override a refused/unknown read) so a receipt from the "UPS" folder isn't
    // left as "Unknown Vendor".
    if (r.folderHint && (!r.extracted.vendor || /unknown|not\s*identified|n\/?a/i.test(r.extracted.vendor))) {
      r.extracted.vendor = r.folderHint;
    }
    r.confidence = data.confidence || 'medium';
    r.flags = Array.isArray(data.flags) ? data.flags : [];
    r.model = MODEL;
    r.rawResponse = { data, usage };
    r.extractionError = '';
    r.status = 'review';
    await r.save();
  } catch (e) {
    if (isRateLimit(e) || isOverloaded(e)) throw e;  // queue pauses + requeues
    r.extractionError = e.message || 'Read failed.';
    r.status = r.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    await r.save();
    if (r.status === 'pending') setTimeout(() => enqueue(id), 15000);
  }
}

async function _loop() {
  try {
    while (_queue.length && !_paused) {
      const id = _queue.shift();
      try {
        await _processOne(id);
      } catch (e) {
        if (isRateLimit(e) || isOverloaded(e)) {
          const wait = retryAfterMs(e);
          _queue.unshift(id);               // keep it; preserve order
          _paused = true;
          _running = false;
          console.warn(`[receipts] ${isRateLimit(e) ? 'rate limited' : 'overloaded'} — pausing ${Math.round(wait / 1000)}s, then resuming`);
          setTimeout(() => { _paused = false; _kick(); }, wait);
          return;
        }
        console.warn('[receipts] unexpected processing error', id, e.message);
      }
      await sleep(400); // gentle pacing
    }
  } finally {
    if (_queue.length === 0 || _paused) _running = false;
  }
}

// On boot, re-enqueue anything left mid-flight so a restart never strands a
// receipt (durability for the "tries again when there's no limit" guarantee).
async function resumeOnBoot() {
  if (!isConfigured()) return;
  try {
    const stuck = await Receipt.find({ status: { $in: ['pending', 'processing'] } }).select('_id').lean();
    stuck.forEach((r) => _queue.push(String(r._id)));
    if (stuck.length) console.log(`[receipts] resuming ${stuck.length} pending receipt(s)`);
    _kick();
  } catch (e) { console.warn('[receipts] resumeOnBoot failed:', e.message); }
}

function queueStatus() {
  return { configured: isConfigured(), model: MODEL, queued: _queue.length, running: _running, paused: _paused };
}

module.exports = {
  isConfigured, enqueue, resumeOnBoot, queueStatus,
  extract, toContentBlock, mapExtracted,   // exported for tests / batch script
  EXPENSE_CATEGORIES, MODEL,
};
