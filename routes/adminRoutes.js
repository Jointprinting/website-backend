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
  listAgents, agentCount, createAgent, updateAgent, resetAgentPassword,
  listAgentOrders, listAgentLeads,
} = require('../controllers/admin');

router.use(requireOwner);

// Cheap count first — a fixed path, declared BEFORE any '/agents/:id' routes.
router.get('/agents/count', agentCount);
router.get('/agents', listAgents);
router.post('/agents', createAgent);
router.patch('/agents/:id', updateAgent);
router.post('/agents/:id/password', resetAgentPassword);
// Owner drill-in: view one agent's book (read-only).
router.get('/agents/:id/orders', listAgentOrders);
router.get('/agents/:id/leads', listAgentLeads);

module.exports = router;
