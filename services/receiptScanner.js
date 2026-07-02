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
const { isSelf, firstNonSelf } = require('./selfIdentity');

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
      // SELLER = whose letterhead / "from" the document is on (top of an invoice,
      // the store on a receipt). On one of OUR OWN invoices this is "Joint
      // Printing"; on a supplier receipt it's the supplier.
      seller:      { type: 'string', description: 'The business that ISSUED this document — whose name/letterhead is at the top (the "from"/"remit to"/store). On an invoice this is the seller; on a store receipt, the merchant.' },
      // BILL-TO = the customer the document is addressed to ("Bill To" / "Sold
      // To" / "Ship To" / "Customer"). On OUR invoice this is the CLIENT who owes
      // us; on a supplier receipt addressed to us it is Joint Printing.
      billTo:      { type: 'string', description: 'The customer this document is addressed TO — the "Bill To" / "Sold To" / "Ship To" / "Customer" name. Empty if not shown.' },
      // documentKind tells income vs expense from the doc itself: is this OUR sales
      // invoice (money coming IN) or a bill/receipt WE paid (money OUT)?
      documentKind:{ type: 'string', enum: ['sales_invoice', 'purchase_receipt'], description: 'Is this document a SALES INVOICE issued by Joint Printing to a customer (money IN) — "sales_invoice" — or a receipt/bill from a supplier that Joint Printing PAID (money OUT) — "purchase_receipt"? Decide from the letterhead/from-name and who is billed.' },
      // vendor kept for back-compat: on a purchase receipt it equals the seller.
      vendor:      { type: 'string', description: 'On a supplier receipt, the business that was paid (supplier/printer/shipper). Usually the same as "seller". Empty on our own sales invoice.' },
      date:        { type: 'string', description: 'Receipt/invoice date as YYYY-MM-DD. Empty string if none is printed.' },
      amount:      { type: 'number', description: 'The TOTAL on the document as a POSITIVE number (incl. tax & shipping).' },
      kind:        { type: 'string', enum: ['charge', 'refund'], description: 'Money OUT or money BACK? "charge" = an invoice/receipt you paid. "refund" = a refund, credit memo, return, "amount refunded", or a negative/credit total coming back to you.' },
      currency:    { type: 'string', description: 'ISO currency code, default USD.' },
      orderNumber: { type: 'string', description: 'Any PO / order / job / invoice number printed on it (digits only ok). Empty if none.' },
      category:    { type: 'string', enum: EXPENSE_CATEGORIES, description: 'Best-fit expense category (for a supplier receipt). Ignored for our own sales invoice.' },
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
    required: ['seller', 'documentKind', 'amount', 'confidence'],
  },
};

const SYSTEM = [
  'You read financial documents for a small merch/screen-print broker named "Joint Printing" (also "Joint Printing LLC", jointprinting.com) and extract structured data.',
  'These are two different documents and you MUST tell them apart:',
  '  (A) OUR OWN SALES INVOICE — Joint Printing issued it to a CUSTOMER who owes/paid us. Letterhead/"from" = Joint Printing; there is a "Bill To"/"Sold To"/"Ship To"/"Customer" who is someone else. This is money IN. Set documentKind="sales_invoice".',
  '  (B) A SUPPLIER RECEIPT / BILL we PAID — issued BY a supplier/printer/shipper/store TO Joint Printing. This is money OUT. Set documentKind="purchase_receipt".',
  'Rules:',
  '- SELLER = whose letterhead/"from"/"remit to" the document is on (the issuer). BILL-TO = the "Bill To"/"Sold To"/"Ship To"/"Customer" it is addressed to. Always capture BOTH when shown; leave billTo empty if it is not printed.',
  '- documentKind: if the SELLER is Joint Printing (our letterhead) it is a "sales_invoice"; otherwise it is a "purchase_receipt". When the layout is ambiguous, prefer "purchase_receipt" (the common case for an uploaded receipt) and add a flag.',
  '- VENDOR (purchase_receipt only): the business that was paid — normally the same as the seller. On our own sales_invoice, leave vendor empty (we are not the vendor on our own sale).',
  '- The TOTAL is the grand total actually charged (after tax and shipping). Do not return a subtotal as the amount.',
  '- Dates are timeline info — capture the receipt/invoice date exactly as printed (convert to YYYY-MM-DD).',
  '- A folder name is often supplied with the receipt — for a purchase_receipt it is almost always the vendor/supplier. Use it as seller/vendor whenever the document itself does not clearly name the merchant (card, bank, and Zelle payment confirmations usually do not). Never return "Unknown"/"N/A" when a folder name was given.',
  '- NEVER refuse, and do not judge whether a purchase looks "business" or "personal" — always extract the data. The owner decides how to categorize it.',
  '- Category guidance (for a purchase_receipt): blank garments (S&S, SanMar, Alphabroder) → "Blank COGS"; contract printing/embroidery/decorating/patches → "Printer COGS"; parcel/freight shipping (UPS, USPS, FedEx, ArcBest) → "Shipping"; digitizing/vectoring/art fees → "Art"; sales commissions → "Commission"; software/SaaS (Render, Google, Notion, Anthropic, OpenAI, Cloudflare, Adobe) → "Software"; sales tax / state revenue → "Sales Tax"; travel/tolls/misc (Amtrak, NJ Transit, ParkMobile) and anything else → "Other".',
  '- Only the seller/vendor may be inferred from the folder; if another field is not present, leave it empty/null and add a flag rather than guessing.',
  '- CHARGE vs REFUND: set "kind" to "refund" when the document is money coming BACK — a refund, credit memo, return, or a negative/credit total — otherwise "charge". The amount stays the positive number shown.',
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

// Decide charge vs refund from the model's `kind`, CONSERVATIVELY. The tool enum
// is exactly ['charge','refund'], so the ONLY safe refund signal is kind ===
// 'refund' (case-insensitive, trimmed). The old code matched /refund|credit|return/
// against the string, which is a direction-flip hazard: a stray "credit card" /
// "store credit" / "returned to floor" in the field would have booked a normal
// expense as an isCredit that nets DOWN the order's COGS and corrupts totals (the
// audit finding). Default is a plain charge — a refund must say so explicitly. A
// genuine refund is rare and gets caught in review; a misread direction silently
// wrecks the ledger, so we bias hard toward "charge".
const isRefundKind = (kind) => String(kind || '').trim().toLowerCase() === 'refund';

// Map the raw tool output onto the Receipt.extracted shape (parse the date,
// coerce numbers, clamp the category to a known bucket). Also keeps the new
// order-flow fields — seller (the issuer), billTo (the addressee), documentKind
// (sales_invoice | purchase_receipt) — so the order-flow-aware party/direction
// decision (decideTransaction) has what it needs. `vendor` stays populated for
// back-compat: on a purchase receipt it falls back to the seller; on our own
// sales invoice the seller is us, so vendor is left blank (we are not the vendor).
function mapExtracted(d) {
  const n = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));
  let date = null;
  if (d.date) { const dt = new Date(d.date); if (!isNaN(dt.getTime())) date = dt; }
  const category = EXPENSE_CATEGORIES.includes(d.category) ? d.category : 'Other';
  const seller = (d.seller || '').trim();
  const billTo = (d.billTo || '').trim();
  const documentKind = d.documentKind === 'sales_invoice' ? 'sales_invoice' : 'purchase_receipt';
  // Back-compat vendor: prefer the model's explicit vendor, else the seller — but
  // never us (on our own sales invoice the seller is Joint Printing, which is not
  // a vendor). A self seller leaves vendor blank.
  let vendor = (d.vendor || '').trim();
  if (!vendor && seller && !isSelf(seller)) vendor = seller;
  return {
    seller,
    billTo,
    documentKind,
    vendor,
    date,
    kind: isRefundKind(d.kind) ? 'refund' : 'charge',
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

// ── order-flow-aware party + direction (the core fix) ────────────────────────
// Decide the ledger fields for a scanned document from its ORDER FLOW, never from
// the letterhead alone. PURE (no DB, no API) so it is unit-testable and reusable;
// the scan controller calls it after an optional Order lookup.
//
//   extracted — the mapExtracted() output (seller, billTo, documentKind, vendor,
//               kind, category, amount, orderNumber, summary, …).
//   order     — the linked Order (or null) found by matching the receipt's
//               order/invoice number. The ORDER is the source of truth for who
//               the client is: its companyName (preferred) / clientName.
//
// Returns { type, category, party, isCredit, source } where `source` records how
// the party was decided ('order' | 'billTo' | 'vendor' | '' ), for transparency.
//
// Rules:
//   • INCOME (our own sales invoice — documentKind 'sales_invoice', i.e. the
//     SELLER is us): money IN for an order. type='income', category='Customer
//     Sales', and party = the CLIENT — the matched Order's company/client name
//     when linked, else the document's bill-to, else the first OTHER (non-self)
//     name on it. Self is NEVER the party; when no client can be determined the
//     party is left '' for the owner to fill (we never guess "Joint Printing").
//   • EXPENSE (a supplier receipt): money OUT for an order. type='expense',
//     party = the VENDOR (the one we paid), category = the read COGS/expense
//     bucket. If the read vendor is somehow us (a self misread), fall back to a
//     non-self name / blank rather than stamping ourselves.
//   • DIRECTION: isCredit follows the strict scanned kind (refund) only — the
//     owner-confirmed value still wins downstream in confirm(); this never flips
//     a charge to a credit on a noisy "credit card" line.
function decideTransaction(extracted, order) {
  const e = extracted || {};
  const orderName = order ? String(order.companyName || order.clientName || '').trim() : '';
  const isCredit = isRefundKind(e.kind);

  // Is this OUR sales invoice? Trust the explicit documentKind, and also treat a
  // self SELLER as a sales invoice (the letterhead is ours) even if the model
  // mislabeled the kind — that is exactly the reported bug.
  const sellerIsSelf = isSelf(e.seller) || isSelf(e.vendor);
  const isSale = e.documentKind === 'sales_invoice' || sellerIsSelf;

  if (isSale) {
    // The client is the OTHER party. Prefer the order link (source of truth),
    // then the bill-to, then any other non-self name we have. Never us, never a guess.
    const party = firstNonSelf(orderName, e.billTo, e.seller, e.vendor);
    const source = party && party === orderName ? 'order' : (party ? 'billTo' : '');
    return { type: 'income', category: 'Client Sales', party, isCredit, source };
  }

  // Supplier receipt → expense. Party is the vendor we paid; never us.
  const party = firstNonSelf(e.vendor, e.seller);
  return {
    type: 'expense',
    category: EXPENSE_CATEGORIES.includes(e.category) ? e.category : 'Other',
    party,
    isCredit,
    source: party ? 'vendor' : '',
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

// Decide what happens to a freshly-read receipt instead of dumping everything
// into "needs review". The goal: you only touch the genuine edge cases.
//   • If it matches an expense already in the ledger → LINK to it (attach the
//     file, no new charge). Handles the historical back-catalog safely.
//   • Else, for a going-forward single upload that read cleanly → BOOK it as a
//     new expense (no order # required — software/gas/travel are just general).
//   • Else (low confidence, no amount, flagged, or a zip whose item isn't in the
//     ledger) → leave it in review.
// Runs sequentially (queue concurrency is 1), so linked ledger rows are excluded
// from the next receipt's search and two receipts can't grab the same entry.
// Receipts are a BACKUP / evidence layer — they NEVER create ledger entries on
// their own (the ledger, from the spreadsheet, is the source of truth and it
// reconciles to the bank). The only automatic action is attaching a receipt's
// file to the matching expense ALREADY in the ledger. A credit/refund never
// matches an expense. Everything else waits in review, where you confirm it —
// which is how a brand-new cost (or one with no receipt) actually gets entered.
async function _autoResolve(r) {
  const Transaction = require('../models/Transaction');
  const round2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
  const digits = (v) => String(v == null ? '' : v).replace(/[^0-9]/g, '');
  const within = (a, b, d) => a && b && Math.abs(new Date(a) - new Date(b)) <= d * 86400000;
  const e = r.extracted || {};
  const amt = round2(e.amount);
  const ord = digits(e.orderNumber);
  const tokens = [e.vendor, r.folderHint]
    .map((s) => (((s || '').toLowerCase().match(/[a-z&]+/)) || [''])[0])
    .filter((t) => t && t.length > 2);

  if (amt > 0 && e.kind !== 'refund') {
    // Attach to a matching ledger expense that doesn't already carry a receipt.
    const expenses = await Transaction.find({
      type: 'expense', $or: [{ receiptUrl: '' }, { receiptUrl: { $exists: false } }],
    }).select('amount party description orderNumber date').lean();
    const cands = expenses.filter((t) => {
      if (Math.abs(round2(t.amount) - amt) > 0.02) return false;
      if (ord && digits(t.orderNumber) === ord) return true;
      const party = (t.party || '').toLowerCase(); const desc = (t.description || '').toLowerCase();
      if (tokens.some((tok) => party.includes(tok) || desc.includes(tok))
        && (!e.date || within(t.date, e.date, 45))) return true;
      return false;
    });
    if (cands.length) {
      // Prefer the closest date when several rows share the amount (e.g. monthly SaaS).
      const ref = e.date ? new Date(e.date) : null;
      if (ref) cands.sort((a, b) => Math.abs(new Date(a.date) - ref) - Math.abs(new Date(b.date) - ref));
      await Transaction.findByIdAndUpdate(cands[0]._id, { receiptUrl: r.fileUrl });
      r.transactionId = cands[0]._id; r.status = 'booked'; r.reviewedAt = new Date();
      return;
    }
  }
  r.status = 'review';
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
    await _autoResolve(r);   // link/book the obvious ones; only edge cases hit review
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
  extract, toContentBlock, mapExtracted, isRefundKind, decideTransaction,  // exported for tests / batch script
  EXPENSE_CATEGORIES, MODEL,
};
