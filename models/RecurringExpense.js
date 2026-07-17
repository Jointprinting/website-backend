const mongoose = require('mongoose');

// A recurring OPERATING subscription the shop PAYS every period — the cost-side
// mirror of models/Subscription.js (which is recurring REVENUE from Webworks/Atom
// clients). This is the owner's own stack: Google Workspace, Render, ChatGPT,
// Claude, Planet Fitness, the backup domain, … Each carries the amount and the
// day of the month it bills, so the Finances page can:
//   • show what recurs and total the monthly outflow;
//   • WAIT for each month's invoice on its due date and nag if it wasn't uploaded
//     ("track my subscriptions and tell me if I didn't upload it"); and
//   • book a clean, brand-tagged expense into the ledger when the invoice lands.
//
// Deliberately NOT folded into Subscription: that model is income-side (brand is
// required + restricted to webworks/atom, and it feeds MRR/ARR). These are costs
// and would pollute the MRR math. They feed the ledger (a Transaction expense),
// not the recurring-revenue rollup. The reminder is Finances-page-only by design.

const RECUR_CADENCES = ['monthly', 'annual'];

// One billing period the owner has settled — the month's invoice was recorded
// (booked to the ledger, optionally with the stored file) or explicitly skipped
// (that period wasn't billed, so stop nagging). Keyed by `period` ('YYYY-MM' for
// monthly, 'YYYY' for annual). The absence of an entry for an elapsed due date is
// exactly what surfaces as a reminder.
const PeriodSchema = new mongoose.Schema({
  period:        { type: String, required: true }, // 'YYYY-MM' | 'YYYY'
  status:        { type: String, default: 'recorded' }, // 'recorded' | 'skipped'
  amount:        { type: Number, default: null },  // what actually billed this period
  recordedAt:    { type: Date, default: Date.now },
  receiptUrl:    { type: String, default: '' },     // the stored invoice/receipt file (R2)
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction', default: null },
  note:          { type: String, default: '' },
  _id: false,
});

const RecurringExpenseSchema = new mongoose.Schema({
  // ── What it is ──
  name:     { type: String, required: true },       // "Google Workspace"
  vendor:   { type: String, default: '' },          // who's paid (ledger party); defaults to name
  amount:   { type: Number, default: 0 },           // expected charge per period (positive)
  cadence:  { type: String, enum: RECUR_CADENCES, default: 'monthly' },
  // Day of the month the charge lands (1-31). Clamped to the month's length when a
  // short month has no such day (a 31 due day bills on Feb 28). The owner controls
  // this — "let me change the monthly dates".
  dueDay:   { type: Number, default: 1, min: 1, max: 31 },

  // ── Ledger shape (used when a period is recorded) ──
  category: { type: String, default: 'Software' },  // a Transaction category
  // Which brand this overhead belongs to, for the per-brand P&L. Same keys as
  // utils/brands.js (contact = Joint Printing overhead by default).
  brand:    { type: String, default: 'contact', index: true },

  // ── Lifecycle / reminders ──
  // When this subscription began billing — reminders never fire before it, so a
  // domain "starting the 20th" doesn't nag for months it didn't exist.
  startDate:   { type: Date, default: Date.now },
  active:      { type: Boolean, default: true, index: true },
  // Per-subscription reminder switch — "have control over these reminders".
  remindersOn: { type: Boolean, default: true },
  notes:       { type: String, default: '' },
  order:       { type: Number, default: 100 },      // display order on the Finances panel

  periods:  { type: [PeriodSchema], default: [] },

  // ── Soft-delete (house rule: nothing is hard-deleted) ──
  archived:       { type: Boolean, default: false, index: true },
  archivedAt:     { type: Date, default: null },
  archivedReason: { type: String, default: '' },
}, { timestamps: true });

RecurringExpenseSchema.index({ archived: 1, active: 1, order: 1 });

RecurringExpenseSchema.statics.RECUR_CADENCES = RECUR_CADENCES;

const RecurringExpense = mongoose.model('RecurringExpense', RecurringExpenseSchema);
RecurringExpense.RECUR_CADENCES = RECUR_CADENCES;

module.exports = RecurringExpense;
