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
  loginCount: { type: Number, default: 0 },       // access-frequency signal for the Admin log
  createdAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date },
  failedLoginAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date },
});

module.exports = mongoose.model('AdminUser', AdminUserSchema);
module.exports.ROLES = ROLES;
