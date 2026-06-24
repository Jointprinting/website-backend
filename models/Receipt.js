const mongoose = require('mongoose');

// A receipt/invoice Nate paid — the REAL source of truth for a cost (more than
// the spreadsheet). The file is stored first, then read by Claude to pull the
// fields, then Nate confirms (editing anything) which books a clean Transaction
// into the ledger. Keeping receipts as their own entity means:
//   • the original file + the raw AI extraction live forever as an audit trail
//     ("the receipts are the real source of truth", "eggs not in one basket");
//   • the ledger (Transaction) stays clean — one confirmed entry per receipt;
//   • every step is inspectable and editable (pending → review → booked).
//
// NOTHING here is auto-trusted: the AI fills the fields, Nate confirms. The file
// is always saved even if the AI read fails, so a cost is never lost.

const LineItemSchema = new mongoose.Schema({
  description: { type: String, default: '' },
  qty:         { type: Number, default: null },
  unitPrice:   { type: Number, default: null },
  amount:      { type: Number, default: null },
  _id: false,
});

// What Claude pulled off the receipt. Mirrors the fields the ledger needs plus
// the extra detail receipts carry (line items, tax/shipping split, dates =
// timeline info). Nate edits these in review before booking.
const ExtractedSchema = new mongoose.Schema({
  vendor:      { type: String, default: '' },   // who he paid (a supplier)
  // The two parties + the document's nature, so the order-flow-aware party/
  // direction decision (income vs expense, client vs vendor) survives the scan→
  // confirm round-trip. Without these here, Mongoose's sub-schema would strip them
  // and confirm() would lose them. `seller` = the issuer/letterhead; `billTo` =
  // the customer the doc is addressed to; documentKind = 'sales_invoice' (our own
  // invoice → money IN) | 'purchase_receipt' (a supplier bill we paid → money OUT).
  seller:      { type: String, default: '' },
  billTo:      { type: String, default: '' },
  documentKind:{ type: String, default: '' },
  date:        { type: Date,   default: null }, // receipt date (timeline)
  kind:        { type: String, default: 'charge' }, // 'charge' (money out) | 'refund' (a credit back to you)
  amount:      { type: Number, default: null }, // the total he was charged
  currency:    { type: String, default: 'USD' },
  orderNumber: { type: String, default: '' },   // links to the customer order, if printed
  category:    { type: String, default: 'Other' },
  subtotal:    { type: Number, default: null },
  tax:         { type: Number, default: null },
  shipping:    { type: Number, default: null },
  lineItems:   { type: [LineItemSchema], default: [] },
  summary:     { type: String, default: '' },   // one-line human description
  _id: false,
});

const ReceiptSchema = new mongoose.Schema({
  // ── the stored original (saved BEFORE any AI call, so nothing is ever lost) ──
  fileUrl:   { type: String, default: '' },   // R2 public URL
  fileName:  { type: String, default: '' },
  fileMime:  { type: String, default: '' },   // application/pdf | image/jpeg | ...
  fileSize:  { type: Number, default: 0 },
  // When uploaded inside a zip, the folder a receipt sat in is almost always the
  // vendor (e.g. "UPS", "Heritage Screen Printing") — a far more reliable signal
  // than reading a payment-confirmation that doesn't name the merchant.
  folderHint: { type: String, default: '' },

  // ── lifecycle ──
  // pending    : uploaded, waiting for the reader (or for the API key)
  // processing : Claude is reading it right now
  // review     : read; fields extracted; waiting on Nate to confirm/correct
  // booked     : confirmed → a Transaction was created
  // failed     : the read errored after retries (Nate can retry or hand-enter)
  // ignored    : Nate dismissed it (duplicate / not a real cost)
  status:    { type: String, default: 'pending', index: true },

  extracted:  { type: ExtractedSchema, default: () => ({}) },
  confidence: { type: String, default: '' },        // high | medium | low
  flags:      { type: [String], default: [] },      // things the reader was unsure about
  attempts:   { type: Number, default: 0 },         // read attempts (for backoff/failed)
  model:      { type: String, default: '' },        // which model read it (provenance)
  extractionError: { type: String, default: '' },

  // ── linkage / provenance ──
  orderNumber:   { type: String, default: '', index: true }, // copy of extracted, for fast filtering
  year:          { type: Number, index: true },
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
  source:        { type: String, default: 'upload' },  // upload | batch | drive
  reviewedAt:    { type: Date, default: null },

  // Full raw model output, kept for audit/debugging. Heavy, so excluded from
  // list queries by default (select:false).
  rawResponse: { type: mongoose.Schema.Types.Mixed, default: null, select: false },
}, { timestamps: true });

// Keep the denormalized filter fields in step with the extracted data.
ReceiptSchema.pre('save', function syncDenorm(next) {
  const d = this.extracted && this.extracted.date;
  if (d) this.year = new Date(d).getUTCFullYear();
  if (this.extracted && this.extracted.orderNumber != null) {
    this.orderNumber = String(this.extracted.orderNumber).replace(/[^0-9]/g, '');
  }
  next();
});

module.exports = mongoose.model('Receipt', ReceiptSchema);
