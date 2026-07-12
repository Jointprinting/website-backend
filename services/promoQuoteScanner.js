// services/promoQuoteScanner.js
//
// Reads a vendor PROMO QUOTE / catalog PDF and pulls out every product + price so
// the owner never hand-types a promo catalog. Same cheap, in-your-control pattern
// as the receipt scanner (services/receiptScanner.js) — it even reuses that
// module's file → Claude-content-block helper:
//
//   • CHEAP  — Haiku 4.5 (fractions of a cent per quote). Env-overridable.
//   • SAFE   — the caller archives the original PDF to R2 first, and NOTHING is
//              written to the catalog until the owner confirms the scanned rows.
//   • FLAGGED — feature-flagged on ANTHROPIC_API_KEY; with no key, scanning is a
//              no-op and the owner adds promo items by hand. Nothing breaks.
//
// Unlike receipts this is a synchronous, review-first read (upload → see the items
// → confirm), not a durable queue: a promo quote is one PDF the owner is actively
// looking at, so immediate feedback beats background processing.

const { toContentBlock } = require('./receiptScanner');

const MODEL = process.env.PROMO_SCAN_MODEL || process.env.RECEIPT_MODEL || 'claude-haiku-4-5';

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

let _client = null;
function _getClient() {
  if (_client) return _client;
  const Anthropic = require('@anthropic-ai/sdk'); // lazy: boot without a key
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 4 });
  return _client;
}

// The single tool we force Claude to call — clean structured output, no parsing.
const RECORD_TOOL = {
  name: 'record_promo_items',
  description: 'Record every distinct promotional product found in this vendor quote or catalog.',
  input_schema: {
    type: 'object',
    properties: {
      vendor: { type: 'string', description: 'The supplier/vendor that issued this quote (their name/letterhead). Empty if not shown.' },
      items: {
        type: 'array',
        description: 'One entry per distinct product. Skip page headers, subtotals, totals, tax, shipping and terms — only real products.',
        items: {
          type: 'object',
          properties: {
            name:        { type: 'string', description: 'Product name, e.g. "Plastic Grinder", "Soft-touch Lighter", "Glass Ashtray".' },
            sku:         { type: 'string', description: 'Vendor item / style number if shown. Empty otherwise.' },
            description: { type: 'string', description: 'Extra detail: size, material, imprint/decoration method, packaging.' },
            category:    { type: 'string', description: 'Short product category: "Grinder", "Lighter", "Ashtray", "Bag", "Apparel", etc.' },
            color:       { type: 'string', description: 'Color if a single one is specified. Empty if several or none.' },
            unitPrice:   { type: ['number', 'null'], description: 'The per-unit price shown for this product (the main / largest-quantity price). Number only — strip $ and commas.' },
            minQty:      { type: ['number', 'null'], description: 'Minimum order quantity if shown.' },
            priceBreaks: {
              type: 'array',
              description: 'Every quantity → per-unit-price break shown for this product, if any.',
              items: { type: 'object', properties: { qty: { type: ['number', 'null'] }, price: { type: ['number', 'null'] } } },
            },
          },
          required: ['name'],
        },
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Overall confidence in the read.' },
      flags:      { type: 'array', items: { type: 'string' }, description: 'Anything unclear or worth a human check.' },
    },
    required: ['items', 'confidence'],
  },
};

const SYSTEM = [
  'You read a vendor PROMOTIONAL-PRODUCTS quote or catalog for a small custom-merch broker named "Joint Printing".',
  'Extract EVERY distinct product line into record_promo_items: name, item/style number, description (size/material/imprint), a short category, color, the per-unit price, minimum quantity, and any quantity price breaks.',
  'Prices are the vendor\'s quoted per-unit prices. Return numbers only (strip "$" and commas). If a field is not shown, leave it empty/null — never guess.',
  'Skip page headers/footers, subtotals, totals, tax, shipping lines, and terms & conditions — only actual products.',
  'If the same product appears at several quantities, capture the quantity breaks in priceBreaks and use the largest-quantity (lowest) price as the main unitPrice.',
  'Always call record_promo_items exactly once.',
].join('\n');

// Read one promo PDF → structured items. Throws on rate-limit/overload so the
// caller can surface it (this path has no durable queue).
async function scan(buffer, mime, fileHint = '') {
  if (!isConfigured()) throw new Error('AI scanning is not configured (set ANTHROPIC_API_KEY).');
  const block = await toContentBlock(buffer, mime);
  const hint = fileHint ? `The file is named "${fileHint}". ` : '';
  const msg = await _getClient().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    tools: [RECORD_TOOL],
    tool_choice: { type: 'tool', name: 'record_promo_items' },
    messages: [{
      role: 'user',
      content: [block, { type: 'text', text: `${hint}Read this promo quote/catalog and record every product with record_promo_items.` }],
    }],
  });
  const tool = (msg.content || []).find((b) => b.type === 'tool_use');
  if (!tool) throw new Error('Model did not return structured promo data.');
  return { data: tool.input || {}, usage: msg.usage || null };
}

// Normalize raw tool output into PromoCatalogItem-shaped objects. The vendor's
// quoted price is treated as the CLIENT price (his promo catalogs already include
// margin); cost is left 0 for the owner to fill in review if he wants COGS.
function mapItems(data, ctx = {}) {
  const n = (v) => (v == null || v === '' || isNaN(Number(v)) ? 0 : Number(v));
  const vendor = (data.vendor || ctx.vendor || '').trim();
  const items = Array.isArray(data.items) ? data.items : [];
  return items
    .filter((it) => it && String(it.name || '').trim())
    .map((it) => ({
      vendor,
      name: String(it.name || '').trim(),
      sku: String(it.sku || '').trim(),
      description: String(it.description || '').trim(),
      category: String(it.category || 'Promo').trim() || 'Promo',
      color: String(it.color || '').trim(),
      price: n(it.unitPrice),
      cost: 0,
      minQty: n(it.minQty),
      unit: 'each',
      priceBreaks: Array.isArray(it.priceBreaks)
        ? it.priceBreaks
          .filter((b) => b && (b.qty != null || b.price != null))
          .map((b) => ({ qty: n(b.qty), price: n(b.price), cost: 0 }))
        : [],
      notes: '',
      active: true,
      sourceFileName: ctx.sourceFileName || '',
      sourcePdfUrl: ctx.sourcePdfUrl || '',
      confidence: data.confidence || 'medium',
    }));
}

module.exports = { isConfigured, scan, mapItems, MODEL, RECORD_TOOL };
