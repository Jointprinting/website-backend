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
  amount:      { type: Number, required: true },             // always positive
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

TransactionSchema.statics.CATEGORIES = CATEGORIES;
TransactionSchema.statics.COGS_CATEGORIES = COGS_CATEGORIES;

module.exports = mongoose.model('Transaction', TransactionSchema);
