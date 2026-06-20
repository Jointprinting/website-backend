const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const ctl = require('../controllers/rateCards');

// Printer pricing matrices are internal — admin only.
router.use(requireAdmin);

// Literal paths first so they aren't shadowed by '/by-name/:printerName'.
router.get('/', ctl.list);
router.post('/lookup', ctl.lookup);
router.get('/by-name/:printerName', ctl.getByName);
router.put('/:id', ctl.update);

module.exports = router;
