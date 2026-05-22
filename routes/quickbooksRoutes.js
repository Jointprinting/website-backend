const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { status, connect, callback, disconnect, sync } = require('../controllers/quickbooks');

// Public — Intuit redirects the browser here with no Bearer token. Gated
// instead by the random `state` value minted in /connect.
router.get('/callback', callback);

// Everything else is admin-only.
router.get('/status',      requireAdmin, status);
router.get('/connect',     requireAdmin, connect);
router.post('/disconnect', requireAdmin, disconnect);
router.post('/sync',       requireAdmin, sync);

module.exports = router;
