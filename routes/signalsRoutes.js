// routes/signalsRoutes.js
//
// Smart Alerts API. Mounted at /api/signals in server.js. One read-only endpoint
// that composes the hub's "what needs your attention" feed. Behind requireAdmin
// (same Studio auth as the rest of the sales tooling).

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { getSignals } = require('../controllers/signals');

router.use(requireAdmin);

router.get('/', getSignals);

module.exports = router;
