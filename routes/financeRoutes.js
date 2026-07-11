const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const ctl = require('../controllers/finances');
const restart = require('../controllers/financeRestart');
const dedupe = require('../controllers/financeDedupe');
const orderReconcile = require('../controllers/orderReconcile');

// Financial data — admin only.
router.use(requireAdmin);

// Literal/report routes first.
router.get('/config', ctl.config);        // finance vocabulary (categories/COGS/fee rates) from the model — the anti-drift source the Studio reads on mount
router.post('/categories', ctl.addCategory);            // owner-managed custom categories…
router.delete('/categories/:name', ctl.removeCategory); // …built-ins stay (they drive P&L math)
router.get('/summary', ctl.summary);
router.get('/by-order', ctl.byOrder);
router.get('/by-month', ctl.byMonth);
router.get('/by-client', ctl.byClient);
router.get('/order-actuals', ctl.orderActuals);
router.get('/payment-gaps', ctl.paymentGaps);
router.get('/missing-receipts', ctl.missingReceipts);
router.get('/nj-sales-tax', ctl.njSalesTax);   // quarterly NJ ST-50 numbers behind the hub reminder
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

// Reconcile ONE order's scattered numbers (e.g. Happy Leaf written as #141/#1050/#1052)
// down to a single canonical # (#138). Preview → confirm → apply; reversible. Auto-hides
// in the UI once nothing is left to fold (the preview comes back empty).
router.get('/order-reconcile/preview', orderReconcile.preview);
router.post('/order-reconcile/preview', orderReconcile.preview);
router.post('/order-reconcile/apply', orderReconcile.apply);
router.post('/order-reconcile/revert', orderReconcile.revert);
router.get('/order-reconcile/status', orderReconcile.status);

router.get('/transactions', ctl.list);
router.post('/transactions', ctl.create);
router.put('/transactions/:id', ctl.update);
router.delete('/transactions/:id', ctl.remove);

module.exports = router;
