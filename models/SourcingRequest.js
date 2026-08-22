// models/SourcingRequest.js
//
// A SOURCING EVENT — the owner's actual process for anything the shop doesn't
// normally sell, in his words:
//
//   "I go to distributor central and do research til I find a few good suppliers
//    and get quotes til I find a good option then id like the winning one saved
//    for future products like that"
//
// Every part of that except the last was unrepresentable. A vendor could only
// exist as a side effect of a PO, so the two suppliers who quoted and lost were
// never recorded — and neither was WHY they lost. Six months later the next rug
// job starts the research from nothing.
//
// So this models the whole event, not just the outcome: the ask, who was
// approached, what each of them quoted, who won, and the reason. `category` is
// what makes it reusable — "future products like that" is a category lookup, and
// the winner of the last decided request in a category is the answer to "who did
// we use for rugs?".
//
// House rules followed: nothing hard-deletes (archive), the ecosystem
// identifiers (companyKey / projectNumber / orderId) are carried so a sourcing
// event hangs off the job that prompted it, and vendorKey is the same canonical
// key Vendor and PurchaseOrder use — so a quote joins the vendor spine rather
// than being a name in a box.

const mongoose = require('mongoose');

// One supplier's answer. A quote that was never given (they didn't respond, or
// declined) is still worth keeping: "we asked them and they don't do this" is
// the finding that stops you asking again next year.
const QuoteSchema = new mongoose.Schema({
  vendorKey:  { type: String, default: '', index: true },
  vendorName: { type: String, default: '' },
  // Money, per unit at the quantity asked for. Null = not quoted (declined /
  // no response), which is different from zero.
  unitCost:   { type: Number, default: null },
  setupCost:  { type: Number, default: null },
  moq:        { type: Number, default: null },
  leadTimeDays: { type: Number, default: null },
  // Freight is usually a sentence at this stage ("$180 LTL to NJ", "included
  // over 250"), not a number anyone can compute yet.
  shipping:   { type: String, default: '' },
  // Where the quote came from — a DistributorCentral listing URL, an email, a
  // phone call. The trail matters when a price is questioned a year later.
  source:     { type: String, default: '' },
  quotedAt:   { type: Date, default: Date.now },
  // They were approached and said no. Kept, not deleted — see above.
  declined:   { type: Boolean, default: false },
  notes:      { type: String, default: '' },
}, { _id: true });

const SourcingRequestSchema = new mongoose.Schema({
  // What is being sourced, in the owner's words. "Custom 3x5 rug, full colour."
  title: { type: String, required: true, trim: true },
  // The reusable handle. "rugs", "enamel pins", "custom packaging" — free text
  // rather than an enum, because the whole point is the thing nobody has a
  // category for yet, and rejecting it at the schema is how it doesn't get
  // recorded.
  //
  // Normalized by a setter rather than a save hook, so "Rugs" and "rugs" are one
  // bucket the moment the value is assigned — including on a lean update path
  // that never calls save().
  category: {
    type: String, default: '', index: true,
    set: (v) => String(v == null ? '' : v).trim().toLowerCase(),
  },

  // Ecosystem links — the same identifiers everything else joins on, so a
  // sourcing event hangs off the job that prompted it and shows on that card.
  companyKey:    { type: String, default: '', index: true },
  projectNumber: { type: String, default: '' },
  orderId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },

  // The ask, so a quote can be compared against what was actually requested.
  qtyNeeded:      { type: Number, default: null },
  targetUnitCost: { type: Number, default: null },
  neededBy:       { type: Date, default: null },
  notes:          { type: String, default: '' },

  quotes: { type: [QuoteSchema], default: [] },

  // The outcome. `winnerVendorKey` is what the "who did we use for rugs?" lookup
  // returns; decisionNote is why, which is the part that stops the same losing
  // supplier being re-approached next time.
  status: { type: String, default: 'open', enum: ['open', 'decided', 'abandoned'], index: true },
  winnerVendorKey: { type: String, default: '', index: true },
  winnerVendorName: { type: String, default: '' },
  decidedAt:    { type: Date, default: null },
  decisionNote: { type: String, default: '' },

  archived:   { type: Boolean, default: false, index: true },
  archivedAt: { type: Date, default: null },
}, { timestamps: true });

// "Who did we settle on for rugs, most recently?" — the query the whole model
// exists to answer.
SourcingRequestSchema.index({ category: 1, status: 1, decidedAt: -1 });
SourcingRequestSchema.index({ archived: 1, status: 1, createdAt: -1 });

// The cheapest all-in quote at the quantity asked for. PURE-ish (reads only this
// doc) and used by both the API and the UI's "best so far" line.
//
// All-in, not unit cost: a supplier $0.40 cheaper per unit with a $250 setup
// loses on a 100-piece job, and comparing unit costs alone picks them anyway.
SourcingRequestSchema.methods.bestQuote = function bestQuote() {
  const qty = Number(this.qtyNeeded) > 0 ? Number(this.qtyNeeded) : 0;
  const scored = (this.quotes || [])
    .filter((q) => q && !q.declined && Number(q.unitCost) > 0)
    .map((q) => {
      const setup = Number(q.setupCost) || 0;
      const allIn = Number(q.unitCost) + (qty > 0 ? setup / qty : 0);
      return { quote: q, allIn: Math.round((allIn + Number.EPSILON) * 10000) / 10000 };
    })
    .sort((a, b) => a.allIn - b.allIn);
  return scored[0] || null;
};

module.exports = mongoose.model('SourcingRequest', SourcingRequestSchema);
