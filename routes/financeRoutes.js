const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const ctl = require('../controllers/finances');
const restart = require('../controllers/financeRestart');
const dedupe = require('../controllers/financeDedupe');

// Financial data — admin only.
router.use(requireAdmin);

// Literal/report routes first.
router.get('/summary', ctl.summary);
router.get('/by-order', ctl.byOrder);
router.get('/by-month', ctl.byMonth);
router.get('/by-client', ctl.byClient);
router.get('/order-actuals', ctl.orderActuals);
router.get('/payment-gaps', ctl.paymentGaps);
router.get('/export', ctl.exportCsv);
router.post('/import', ctl.importCsv);

// Restart finances from the owner's budget trackers (preview → confirm → apply;
// reversible). Replaces the budget-sourced ledger, preserves manual entries.
router.get('/restart/preview', restart.restartPreview);
router.post('/restart/preview', restart.restartPreview);
router.post('/restart/apply', restart.restartApply);
router.post('/restart/revert', restart.restartRevert);
router.get('/restart/status', restart.restartStatus);

// Merge cross-source duplicate transactions the budget restart left behind (a budget
// row + the owner's manual/receipt copy of the SAME payment, dates drifted apart).
// Preview → confirm → apply; reversible. Merges each pair into ONE row keeping EVERY
// link (receipt, project/order link, invoice #); never deletes a link.
router.get('/dedupe/preview', dedupe.dedupePreview);
router.post('/dedupe/preview', dedupe.dedupePreview);
router.post('/dedupe/apply', dedupe.dedupeApply);
router.post('/dedupe/revert', dedupe.dedupeRevert);
router.get('/dedupe/status', dedupe.dedupeStatus);

router.get('/transactions', ctl.list);
router.post('/transactions', ctl.create);
router.put('/transactions/:id', ctl.update);
router.delete('/transactions/:id', ctl.remove);

module.exports = router;
