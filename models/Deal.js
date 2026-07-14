const mongoose = require('mongoose');

// A DEAL — one opportunity/job for a business, the unit the sales pipeline moves.
// This is the piece the CRM was missing: the old model put "won"/"customer" on the
// COMPANY (a single hand-set stage tied to nothing), so "win THIS deal" had no home.
// Now a business (Client, keyed by companyKey) has MANY deals, each with its own
// lifecycle, and the business's "client" status is DERIVED from them (≥1 won deal).
//
// A deal can exist BEFORE there's a quote — the "details_needed" stage, where the
// owner is still chasing product/design details. Once work starts it links to an
// Order (orderNumber/projectNumber); it wins ONLY when that order is delivered
// (auto — there is no manual Win), and a first win makes the business a client.
//
// Reversibility: deals created by the one-time "set up deals from my orders"
// migration are stamped with `origin: 'migration'` + a `migrationBatch` id, so the
// whole migration is undoable by deleting that batch. The migration NEVER modifies
// Orders or Clients, so deleting the migrated deals restores the exact prior state.

// The deal pipeline, matched to how the owner actually works a job. Ordered from
// open → closed:
//   'details_needed' — chasing product + design details from the client
//   'quoting'        — details in hand; mockups and the quote are being built
//   'quote_sent'     — the quote/approval link went to the client
//   'won'            — ONLY when the linked order is delivered (owner's rule; no
//                      manual Win button anywhere)
//   'lost'
// (Cutover note: the old 4-stage pipeline was qualifying → quoted → won/lost.
// migrateDealStages() in controllers/deals.js maps qualifying → details_needed and
// quoted → quoting at boot — 'quoting' not 'quote_sent', so a built-but-never-sent
// quote can't read as sent; the share-link hook promotes it when it really goes out.)
const DEAL_STAGES = ['details_needed', 'quoting', 'quote_sent', 'won', 'lost'];
const WON_STAGE = 'won';
const OPEN_STAGES = ['details_needed', 'quoting', 'quote_sent'];   // still in play
const CLOSED_STAGES = ['won', 'lost'];

// Which deal stage an existing Order's status maps to (used by the migration that
// seeds deals from orders, and by the auto-sync when an order changes status).
// A placed/in-production/shipped order is still an OPEN deal ('quote_sent') — the
// owner's rule is a deal wins only at delivery. PURE.
function dealStageFromOrderStatus(status) {
  switch (String(status || '')) {
    case 'delivered':
      return 'won';
    case 'cancelled':
      return 'lost';
    case 'placed':
    case 'in_production':
    case 'shipped':
    case 'approved':
      return 'quote_sent';
    case 'quoted':
    default:
      return 'quoting';
  }
}

const DealSchema = new mongoose.Schema({
  dealNumber: { type: String, default: '', index: true },   // human id ("D-14"); minted on create
  // The business this deal belongs to — the SAME companyKey Orders/Clients use, so a
  // business's one profile ties to its many deals and their orders.
  companyKey:  { type: String, required: true, index: true },
  companyName: { type: String, default: '' },               // denormalized for the card, no join needed
  title:       { type: String, default: '' },               // "Spring hoodies", "Reorder", etc.
  stage:       { type: String, enum: DEAL_STAGES, default: 'details_needed', index: true },
  value:       { type: Number, default: 0 },                // estimated deal value (owner's guess pre-quote; the order's total once quoted)

  // Which account owns this deal — an AdminUser _id (string). '' = the owner's.
  // Mirrors Client.agentId / Order.agentId so an agent sees only their own pipeline.
  agentId:     { type: String, default: '', index: true },

  // Link to the fulfillment Order once the deal is quoted (empty for a pre-quote
  // qualifying deal). companyKey + these are the shared ids that tie deal ⇄ order.
  orderNumber:   { type: String, default: '', index: true },
  projectNumber: { type: String, default: '', index: true },
  // The Order._id this deal was seeded from (migration) or is quoting. The exact
  // idempotency key: the migration skips an order that already has a deal, so it's
  // safe to re-run and never duplicates. Empty for a pure pre-quote deal.
  sourceOrderId: { type: String, default: '', index: true },

  quoteSentAt: { type: Date, default: null },   // first time the quote/approval link went out
  wonAt:      { type: Date, default: null },
  lostAt:     { type: Date, default: null },
  lostReason: { type: String, default: '' },

  // Provenance — 'manual' (owner created it), 'migration' (seeded from an existing
  // order by the one-time setup), 'order' (auto-created alongside a new quote).
  origin:         { type: String, default: 'manual', index: true },
  // Reversibility handle: every deal a single migration run creates is stamped with
  // that run's id, so the run is undoable as a unit (delete the batch). Empty for
  // deals created any other way.
  migrationBatch: { type: String, default: '', index: true },

  notes: { type: String, default: '' },

  // Soft-delete (mirrors Client/Order). Nothing is hard-deleted from normal use;
  // archiving drops a deal out of the board while preserving it. The migration
  // rollback is the ONE place deals are hard-deleted — and only the ones it created.
  archived:       { type: Boolean, default: false, index: true },
  archivedAt:     { type: Date, default: null },
  archivedReason: { type: String, default: '' },
}, { timestamps: true });

// Keep won/lost/quote-sent timestamps honest with the stage, whichever path set it.
DealSchema.pre('save', function (next) {
  if (this.isModified('stage')) {
    if (this.stage === 'won') {
      if (!this.wonAt) this.wonAt = new Date();
      this.lostAt = null;
    } else if (this.stage === 'lost') {
      if (!this.lostAt) this.lostAt = new Date();
      this.wonAt = null;
    } else {
      // Reopened to an open stage — clear both close stamps.
      this.wonAt = null;
      this.lostAt = null;
    }
    if (this.stage === 'quote_sent' && !this.quoteSentAt) this.quoteSentAt = new Date();
  }
  next();
});

const Deal = mongoose.model('Deal', DealSchema);
Deal.DEAL_STAGES = DEAL_STAGES;
Deal.WON_STAGE = WON_STAGE;
Deal.OPEN_STAGES = OPEN_STAGES;
Deal.CLOSED_STAGES = CLOSED_STAGES;
Deal.dealStageFromOrderStatus = dealStageFromOrderStatus;

module.exports = Deal;
