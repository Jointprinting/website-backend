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
