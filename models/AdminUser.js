// models/AdminUser.js
//
// One account per Studio user. The OWNER (username 'studio') sees everything;
// AGENTS are sales staff the owner onboards — they get their own login and see
// only their own Orders + CRM (scoped by agentId elsewhere). Kept one collection
// so login/lockout/hardening is shared; role gates what each account can reach.

const mongoose = require('mongoose');

const ROLES = ['owner', 'agent'];

const AdminUserSchema = new mongoose.Schema({
  username: {
    type: String,
    default: 'studio',
    unique: true,
    required: true,
    trim: true,
    lowercase: true, // usernames are case-insensitive identifiers
  },
  passwordHash: {
    type: String,
    required: true,
  },
  // 'owner' = Nate (all screens + Admin). 'agent' = onboarded sales staff
  // (Orders + CRM, own records only). Pre-existing rows have no role — the login
  // path treats a role-less 'studio' account as the owner and self-heals it.
  role: { type: String, enum: ROLES, default: 'agent', index: true },
  displayName: { type: String, default: '' },   // shown in the Studio + on their stats
  active: { type: Boolean, default: true },       // owner can disable an agent's access
  createdBy: { type: String, default: '' },       // owner username who onboarded them
  // Owner-set monthly sales goal for the agent's encouraging/discouraging stats.
  monthlyGoal: { type: Number, default: 0 },
  goalMonth: { type: String, default: '' },       // 'YYYY-MM' the goal applies to
  // Commission deal for this agent. Percentages are of an order's GROSS PROFIT
  // (never revenue). Stored per-agent and owner-editable in the Team tab, so
  // changing someone's deal — or running two agents on different terms — is a
  // settings edit rather than a deploy. The math that reads this lives in
  // services/commission.js; DEFAULT_COMMISSION there is the single source of
  // the shape and the starting numbers, and normalizeConfig() tolerates a
  // missing or partial sub-doc on older rows.
  // `enabled` gates the agent's My Earnings tab: off until the owner has
  // actually agreed terms, so a new agent never sees a half-configured number.
  commission: {
    enabled:          { type: Boolean, default: false },
    fastStartOrders:  { type: Number, default: 3 },
    houseReordersPay: { type: Boolean, default: false },
    tiers: {
      type: [{
        _id:               false,
        name:              { type: String, default: '' },
        minLifetimeProfit: { type: Number, default: 0 },
        selfPct:           { type: Number, default: 0 },
        housePct:          { type: Number, default: 0 },
        reorderPct:        { type: Number, default: 0 },
      }],
      default: undefined,   // absent → services/commission.js supplies the ladder
    },
  },
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  // `active` above is the ACCESS switch (it revokes the session). These are the
  // HISTORY, and they exist because without them tenure, ramp, churn and cohort
  // retention are all literally uncomputable for anyone who leaves — the moment
  // an account is switched off, every fact about how long they lasted and why is
  // gone. Nothing here is derivable after the fact, so it must be recorded as it
  // happens.
  //
  // status is the owner-facing state; `active` stays the thing auth reads, so no
  // gate changes meaning. They are kept in sync by controllers/admin.js.
  status: {
    type: String,
    enum: ['applicant', 'onboarding', 'active', 'paused', 'departed'],
    default: 'onboarding',
    index: true,
  },
  // When they were cleared to sell — NOT createdAt. The gap between the two is
  // onboarding drag, and the clock for "time to first sale" starts here, or a
  // slow paperwork week reads as a slow rep.
  startedSellingAt: { type: Date, default: null },
  // Set once, when they stop. `kind` is the analytic fact (voluntary vs not is
  // what separates a retention problem from a hiring problem); `reason` is the
  // owner's note.
  departedAt:     { type: Date, default: null, index: true },
  departedKind:   { type: String, enum: ['', 'quit', 'let_go', 'never_started', 'other'], default: '' },
  departedReason: { type: String, default: '' },
  // Where they came from. The only way to learn which channel produces reps that
  // last, which is the question that decides where to recruit next.
  recruitSource: { type: String, default: '' },
  territory:     { type: String, default: '' },

  // ── Identity & compliance ─────────────────────────────────────────────────
  // What is needed to pay someone and to defend contractor status — deliberately
  // NOT the sensitive artifacts themselves. See services/agentLifecycle.js:
  // the W-9 document is tracked as RECEIVED, never stored, because this stack has
  // no private file storage and a full SSN must not exist in it.
  legalName:    { type: String, default: '' },
  contactEmail: { type: String, default: '' },
  phone:        { type: String, default: '' },
  entityName:   { type: String, default: '' },   // their LLC, if they have one (ABC prong C evidence)
  entityEin:    { type: String, default: '' },   // an EIN is a business id, not a personal one
  tinLast4:     { type: String, default: '' },   // LAST FOUR ONLY — never the full TIN/SSN
  hasOtherClients: { type: Boolean, default: false },  // prong C: do they sell for anyone else

  // ── Onboarding ────────────────────────────────────────────────────────────
  // Completions only, keyed to the canonical checklist in
  // services/agentLifecycle.js. Storing keys rather than a copy of the checklist
  // means adding or renaming a step needs no migration, and one definition drives
  // both the UI and the access gates.
  onboarding: {
    type: Map,
    of: new mongoose.Schema({
      doneAt: { type: Date, default: Date.now },
      by:     { type: String, default: '' },
      note:   { type: String, default: '' },
      _id: false,
    }),
    default: undefined,
  },

  // ── Cost to carry ─────────────────────────────────────────────────────────
  // What this person costs regardless of what they sell. Without it "net
  // contribution" is just commission subtracted from profit, which flatters
  // every rep who never sells enough to cover their seat.
  seatCostMonthly:   { type: Number, default: 0 },  // e.g. a Google Workspace seat
  onboardingCostOnce: { type: Number, default: 0 }, // one-off setup/recruiting spend

  // ── Owner support time ────────────────────────────────────────────────────
  // The genuinely scarce input in a solo-owner rep network — Fresh Prints backs
  // every rep with a paid mentor; here it is the owner's own hours. Logged at
  // each check-in so cost-per-rep and "how many reps can I actually carry" stop
  // being guesses. Until entries exist, the roster says so instead of implying
  // support is free.
  supportLog: {
    type: [new mongoose.Schema({
      at:      { type: Date, default: Date.now },
      minutes: { type: Number, default: 0 },
      note:    { type: String, default: '' },
      _id: false,
    })],
    default: undefined,
  },
  // The owner's standing call on this rep, set at a review and dated. The one
  // field on the scorecard that is a DECISION rather than a measurement.
  disposition:     { type: String, enum: ['', 'keep', 'coach', 'cut'], default: '' },
  dispositionAt:   { type: Date, default: null },
  dispositionNote: { type: String, default: '' },

  loginCount: { type: Number, default: 0 },       // access-frequency signal for the Admin log
  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date },
  failedLoginAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date },
  // Session-revocation stamp. Bumped whenever the owner disables the account or
  // resets its password; any token issued BEFORE this instant is refused by
  // requireActiveAgent (middleware/auth.js). This is what makes "access stops
  // immediately" real for agents, closing the gap where a still-valid JWT would
  // otherwise outlive a deactivation for the token's whole TTL.
  credentialsChangedAt: { type: Date },
});

module.exports = mongoose.model('AdminUser', AdminUserSchema);
module.exports.ROLES = ROLES;
