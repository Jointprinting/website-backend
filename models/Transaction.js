const mongoose = require('mongoose');

// A single financial transaction — the clean, structured replacement for the
// old prefix-soup ledger. Income vs expense is explicit (not guessed from a
// description), every cost can be linked to an order, and categories drive the
// P&L + analytics. Populated by importing the JP Ledger CSV and, going forward,
// auto-appended from orders (where the customer is known, so no name guessing).
//
// NOTE: financial data lives only in the DB (and the owner's exported CSV/Sheet)
// — never committed to the repo.

const CATEGORIES = [
  'Customer Sales', 'Blank COGS', 'Printer COGS', 'Shipping', 'Art', 'Commission',
  'Software', 'Owner Draw', 'Owner Contribution', 'Sales Tax', 'Refund', 'Other',
];
// COGS categories that net against an order's revenue for per-order margin.
const COGS_CATEGORIES = ['Blank COGS', 'Printer COGS', 'Shipping', 'Art', 'Commission'];

const TransactionSchema = new mongoose.Schema({
  date:        { type: Date, required: true, index: true },
  type:        { type: String, enum: ['income', 'expense'], required: true },
  category:    { type: String, default: 'Other' },
  orderNumber: { type: String, default: '', index: true },  // normalized digits, '' if none
  party:       { type: String, default: '' },               // customer (income) or vendor (expense)
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
  year:        { type: Number, index: true },                // denormalized for fast filtering
  source:      { type: String, default: 'manual' },          // 'import' | 'order:auto' | 'manual'
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

module.exports = mongoose.model('Transaction', TransactionSchema);
