const mongoose = require('mongoose');

// A single financial transaction — the clean, structured replacement for the
// old prefix-soup ledger. Income vs expense is explicit (not guessed from a
// description), every cost can be linked to an order, and categories drive the
// P&L + analytics. Populated by importing the JP Ledger CSV and, going forward,
// auto-appended from orders (where the customer is known, so no name guessing).
//
// NOTE: live financial data lives in the DB (and the owner's exported CSV/Sheet).
// The ONE committed exception is data/financeLedgerSeed.json — the owner's verified
// budget ledger, committed deliberately (like data/notionCrmSeed.json for the CRM)
// so the "Restart finances from my budgets" flow has a reproducible, reviewable
// source of truth to load. It is admin-gated behind the same auth as the rest of
// the finance API. No other finance data is committed.

const CATEGORIES = [
  'Customer Sales', 'Blank COGS', 'Printer COGS', 'Shipping', 'Art', 'Commission',
  'Processing Fee', 'Software', 'Marketing', 'Accounting', 'Travel/Field',
  'Owner Draw', 'Owner Contribution', 'Sales Tax', 'Refund', 'Other',
];
// COGS categories that net against an order's revenue for per-order margin.
// 'Processing Fee' is the merchant fee a payment processor takes out of a client
// payment (CC ~2.99%, ACH ~1%). It's a REAL cost of making the sale, booked as an
// expense linked to the SAME order, so it reduces that order's profit exactly like
// blanks/printer/shipping do. Owner-side only (the client-facing fee-on-approval is
// a later phase). It is intentionally LAST among the COGS group so existing COGS
// ordering is undisturbed.
const COGS_CATEGORIES = ['Blank COGS', 'Printer COGS', 'Shipping', 'Art', 'Commission', 'Processing Fee'];

const TransactionSchema = new mongoose.Schema({
  date:        { type: Date, required: true, index: true },
  type:        { type: String, enum: ['income', 'expense'], required: true },
  category:    { type: String, default: 'Other' },
  orderNumber: { type: String, default: '', index: true },  // normalized digits, '' if none
  // The Order Tracker's project # for the linked order, denormalized at write time
  // (from the Order doc that matches `orderNumber`) so finance can report per
  // PROJECT as well as per invoice/order. '' when there is no linked order or the
  // order predates project numbers. Kept as a string to match how the rest of the
  // app passes it around (deep links, Order.projectNumber).
  projectNumber: { type: String, default: '', index: true },
  party:       { type: String, default: '' },               // customer (income) or vendor (expense)
  // Hard link to the Vendor this EXPENSE was paid to (the printer/supplier card in
  // the Vendors tab). `party` stays the display string the owner typed; vendorId is
  // the durable reference that survives renames and powers exact per-vendor spend +
  // ledger→Vendor deep links. Null for income rows and legacy rows (the backfill
  // script + name matching cover those).
  vendorId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor', default: null, index: true },
  description: { type: String, default: '' },
  amount:      { type: Number, required: true },             // always positive — magnitude only
  // A credit/return reverses the normal direction of its `type`, without going
  // negative in the DB: an EXPENSE credit is a supplier credit/refund coming
  // BACK to us (nets DOWN that cost/COGS); an INCOME credit is a customer refund
  // going back OUT (nets DOWN revenue). Aggregations apply `amount * (isCredit
  // ? -1 : 1)` within the row's type bucket. Default false → legacy rows behave
  // exactly as before.
  isCredit:    { type: Boolean, default: false },
  qbSynced:    { type: Boolean, default: false },
  receiptUrl:  { type: String, default: '' },                // stored invoice/receipt file (R2)
  // The owner's INVOICE number for this sale/cost (e.g. "1052"), distinct from the
  // app's project/order link (`orderNumber`). A manual entry the owner books often
  // carries the invoice # he wrote on the paper, while the budget twin of the same
  // payment carries the project/order link instead — the merge-duplicates flow keeps
  // BOTH on the single survivor so neither identifier is lost. Free-form ('' if none).
  invoiceNumber: { type: String, default: '', index: true },
  // How a CLIENT PAYMENT (income/Customer Sales) was taken — drives the auto-booked
  // merchant Processing Fee expense. 'cc' (~2.99%) | 'ach' (~1%) | 'none'/'' (no fee,
  // e.g. cash/check or a fee the owner waived). Only meaningful on the payment row;
  // ignored on expenses. Default '' so every legacy/historical row is "no method"
  // and is NEVER retro-charged a fee.
  paymentMethod: { type: String, default: '' },
  // Optional OWNER OVERRIDE of the fee rate for THIS payment (a fraction, e.g. 0.025
  // for a negotiated 2.5%). Persisted so re-rating on a later edit uses the owner's
  // rate, not the default — null/absent means "use the CC/ACH default". Stored on the
  // payment row (the fee row is derived from it).
  feeRateOverride: { type: Number, default: null },
  // Set on the auto-generated Processing Fee EXPENSE row, pointing at the _id of the
  // client-payment row that spawned it. Makes the fee idempotent: re-saving or
  // editing a payment can find-and-replace its single fee row instead of stacking a
  // second one, and a manually-added fee (no link) is left alone.
  feeForTxn:   { type: String, default: '' },
  year:        { type: Number, index: true },                // denormalized for fast filtering
  source:      { type: String, default: 'manual' },          // 'import' | 'order:auto' | 'manual' | 'budget' | 'fee:auto' | 'receipt' | 'merge'
  // Finance-restart audit/revert handle. Every row INSERTED by a single run of the
  // owner-triggered "restart finances from my budgets" flow is stamped with that
  // run's batch id, so the whole restart is identifiable and reversible as a unit
  // (revert restores the prior budget rows from the soft-deleted backup). Empty for
  // rows the restart never created. Pairs with source:'budget'.
  restartBatchId: { type: String, default: '', index: true },
  // Merge-duplicate-transactions audit/revert handle. The SURVIVOR row of every
  // merged cross-source pair is stamped with the run's batch id, so the whole merge
  // is identifiable and reversible as a unit (revert restores the two original rows
  // from the snapshotted backup and rolls the survivor's fields back). Empty for rows
  // no merge ever touched.
  dedupeBatchId: { type: String, default: '', index: true },
  // Audit trail of the row(s) folded INTO this survivor by a merge — a plain-object
  // snapshot of each absorbed transaction (its receipt/order/invoice/party), so the
  // owner can always see what was combined and a revert has the originals on hand.
  // Empty unless this row is a merge survivor.
  mergedFrom:  { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { timestamps: true });

// Keep `year` in sync with `date` so reports can filter cheaply.
TransactionSchema.pre('save', function syncYear(next) {
  if (this.date) this.year = new Date(this.date).getUTCFullYear();
  next();
});

// Same invariant for update paths — findByIdAndUpdate / findOneAndUpdate do NOT
// fire the 'save' hook, so without this an edit that moves a transaction's date
// would leave `year` stale (the row then shows up under the wrong year in the
// P&L and as a phantom month in the trend chart).
TransactionSchema.pre('findOneAndUpdate', function syncYearOnUpdate(next) {
  const u = this.getUpdate() || {};
  const date = u.date != null ? u.date : (u.$set && u.$set.date);
  if (date != null) {
    const y = new Date(date).getUTCFullYear();
    if (u.$set) u.$set.year = y; else u.year = y;
    this.setUpdate(u);
  }
  next();
});

TransactionSchema.statics.CATEGORIES = CATEGORIES;
TransactionSchema.statics.COGS_CATEGORIES = COGS_CATEGORIES;

// Default merchant-processing rates (as fractions of the payment amount). These
// match the owner's real numbers — orders already carry notes like "JP pays …
// (2.99%) CC fee" and "ACH 1%". Overridable per-call (owner can pass a custom
// rate) but these are the defaults. 'none'/'' = no processor fee (cash/check or a
// waived fee). Kept on the model so the controller, tests, and any future surface
// all read ONE source of truth.
TransactionSchema.statics.PROCESSING_FEE_RATES = { cc: 0.0299, ach: 0.01, none: 0 };

module.exports = mongoose.model('Transaction', TransactionSchema);
