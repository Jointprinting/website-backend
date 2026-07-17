// routes/recurringExpenseRoutes.js — the owner's recurring OPERATING subscriptions
// (Google Workspace, Render, ChatGPT, Claude, gym, backup domain, …). The cost-side
// twin of subscriptionRoutes.js: track what recurs, remind when a month's invoice is
// past due and unrecorded, and book a clean brand-tagged expense when it lands.
// Admin-only (router-scoped), Finances-page-only surface.
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  list, create, update, remove, record, skip, unrecord,
} = require('../controllers/recurringExpenses');

router.use(requireAdmin);

router.get('/',              list);       // list + decorated status + reminders + totals
router.post('/',             create);
router.put('/:id',           update);     // edit amount / due day / brand / …
router.delete('/:id',        remove);     // soft-delete

router.post('/:id/record',   record);     // a month's invoice landed → book + settle period
router.post('/:id/skip',     skip);       // this period wasn't billed → settle-as-skipped
router.post('/:id/unrecord', unrecord);   // undo a settled period (archives its ledger row)

module.exports = router;
