const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const ctl = require('../controllers/finances');

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

router.get('/transactions', ctl.list);
router.post('/transactions', ctl.create);
router.put('/transactions/:id', ctl.update);
router.delete('/transactions/:id', ctl.remove);

module.exports = router;
