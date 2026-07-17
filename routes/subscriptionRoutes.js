// routes/subscriptionRoutes.js — recurring revenue (JP Webworks + JP Atom). Admin-only.
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  listSubscriptions, subscriptionSummary, createSubscription,
  updateSubscription, setStatus, deleteSubscription,
} = require('../controllers/subscriptions');

router.use(requireAdmin);

// STATIC path first so 'summary' is never read as an :id.
router.get('/summary',      subscriptionSummary);   // MRR/ARR rollup (+ ?brand=)

router.get('/',             listSubscriptions);      // ?brand= &status= &companyKey=
router.post('/',            createSubscription);
router.put('/:id',          updateSubscription);
router.post('/:id/status',  setStatus);              // { status: active|paused|canceled, reason? }
router.delete('/:id',       deleteSubscription);     // soft-delete

module.exports = router;
