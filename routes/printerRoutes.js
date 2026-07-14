// routes/printerRoutes.js — owner-only printer network (quoter picker + pricing).
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { listPrinters, getPrinter } = require('../controllers/printers');

router.use(requireAdmin);
router.get('/', listPrinters);
router.get('/:key', getPrinter);

module.exports = router;
