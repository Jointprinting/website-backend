// routes/adminRoutes.js
//
// OWNER-only agent administration, mounted at /api/admin. Every route is behind
// requireOwner, so a logged-in agent gets a 403 — they can never see or manage
// accounts. (The backup sub-router lives at /api/admin/backup, mounted
// separately in server.js.)

const express = require('express');
const router = express.Router();
const { requireOwner } = require('../middleware/auth');
const {
  roster, scorecardOne, updateProfile, setOnboardingStep, logSupport,
  departAgent, reinstateAgent,
} = require('../controllers/agentRoster');
const {
  listAgents, agentCount, createAgent, updateAgent, resetAgentPassword, reassignAgentBook,
  listAgentOrders, listAgentLeads,
} = require('../controllers/admin');

router.use(requireOwner);

// Fixed paths first, declared BEFORE any '/agents/:id' route so a literal
// segment can never be swallowed as an id.
router.get('/agents/count', agentCount);
// The whole Agent Manager payload — roster + rollup + survival lanes — in one
// read with a query count that does not grow with the roster.
router.get('/agents/roster', roster);
router.get('/agents', listAgents);
router.post('/agents', createAgent);
router.patch('/agents/:id', updateAgent);
router.post('/agents/:id/password', resetAgentPassword);
// Owner drill-in: view one agent's book (read-only).
router.get('/agents/:id/orders', listAgentOrders);
router.get('/agents/:id/leads', listAgentLeads);
// Hand a whole book to the owner or another agent (an agent leaving). Moves
// who WORKS each record; never who SOURCED it, so commission history survives.
router.post('/agents/:id/reassign', reassignAgentBook);

// ── Agent Manager ──────────────────────────────────────────────────────────
// The roster + per-person lifecycle. Fixed query count regardless of roster
// size (see controllers/agentRoster.js), unlike the legacy /agents read.
router.get('/agents/:id/scorecard', scorecardOne);
router.patch('/agents/:id/profile', updateProfile);
router.post('/agents/:id/onboarding', setOnboardingStep);
router.post('/agents/:id/support', logSupport);
router.post('/agents/:id/depart', departAgent);
router.post('/agents/:id/reinstate', reinstateAgent);

module.exports = router;
