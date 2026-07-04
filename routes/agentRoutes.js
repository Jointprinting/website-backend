// routes/agentRoutes.js
//
// The sales-agent portal, mounted at /api/agent. Behind requireAuth (any signed-in
// account) — NOT requireOwner — because agents need it, but every handler scopes
// reads/writes to the caller's own agentId via the P2 scope helpers, so an agent
// only ever sees their own leads + orders. This router intentionally exposes none
// of the owner-only cost / PO / vendor / cleanup surface.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  me, listMyOrders, createMyOrder, updateMyOrder,
  listMyLeads, createMyLead, updateMyLead,
} = require('../controllers/agentPortal');

router.use(requireAuth);

router.get('/me', me);

router.get('/orders', listMyOrders);
router.post('/orders', createMyOrder);
router.put('/orders/:id', updateMyOrder);

router.get('/leads', listMyLeads);
router.post('/leads', createMyLead);
router.patch('/leads/:companyKey', updateMyLead);

module.exports = router;
