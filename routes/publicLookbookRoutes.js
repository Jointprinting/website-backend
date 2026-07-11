// routes/publicLookbookRoutes.js — the client-facing lookbook gallery.
// No auth middleware: access is gated by the per-lookbook share token in the
// controller (404 invalid / 410 expired), exactly like the approval flow.
// Mounted under /api/public (server.js).

const express = require('express');
const router = express.Router();

const { publicGetLookbook, publicPostFeedback, publicRequestPricing } = require('../controllers/lookbooks');

router.get ('/:id',                 publicGetLookbook);
router.post('/:id/feedback',        publicPostFeedback);
router.post('/:id/request-pricing', publicRequestPricing);

module.exports = router;
