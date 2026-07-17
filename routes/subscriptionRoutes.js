// routes/subscriptionRoutes.js — recurring revenue (JP Webworks + JP Atom). Admin-only.
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  listSubscriptions, subscriptionSummary, createSubscription,
  updateSubscription, setStatus, deleteSubscription,
  recordPlan, skipPlan, unrecordPlan,
} = require('../controllers/subscriptions');

router.use(requireAdmin);

// STATIC path first so 'summary' is never read as an :id.
router.get('/summary',      subscriptionSummary);   // MRR/ARR rollup + dueThisPeriod (+ ?brand=)

router.get('/',             listSubscriptions);      // ?brand= &status= &companyKey=
router.post('/',            createSubscription);
router.put('/:id',          updateSubscription);
router.post('/:id/status',  setStatus);              // { status: active|paused|canceled, reason? }
router.post('/:id/record',  recordPlan);             // "record this month's plan" → books income
router.post('/:id/skip',    skipPlan);               // this period not billed → settle-as-skipped
router.post('/:id/unrecord', unrecordPlan);          // undo a recorded period (archives its income row)
router.delete('/:id',       deleteSubscription);     // soft-delete

module.exports = router;
