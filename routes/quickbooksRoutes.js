// routes/quickbooksRoutes.js — QuickBooks Online OAuth connection. Mirrors
// gdriveRoutes: the callback is public (Intuit redirects the browser here with no
// Bearer token, gated instead by the random `state`); everything else is admin.
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { status, connect, callback, disconnect } = require('../controllers/quickbooks');

// Public — Intuit redirects the browser here after consent.
router.get('/callback', callback);

// Admin-only.
router.get('/status',      requireAdmin, status);
router.get('/connect',     requireAdmin, connect);
router.post('/disconnect', requireAdmin, disconnect);

module.exports = router;
