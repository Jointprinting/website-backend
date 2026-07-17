// routes/printerRoutes.js — owner-only printer network (quoter picker + pricing).
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  listPrinters, getPrinter,
  createPrinter, updatePrinter, putCatalogSection, archiveCatalogSection,
} = require('../controllers/printers');

router.use(requireAdmin);              // owner-only — the whole printer network
router.get('/', listPrinters);
router.post('/', createPrinter);        // add a printer (no committed JSON needed)
router.get('/:key', getPrinter);
router.patch('/:key', updatePrinter);   // edit meta / contacts / mark pricing reviewed
router.put('/:key/catalog/:section', putCatalogSection);      // create/replace a price book
router.delete('/:key/catalog/:section', archiveCatalogSection); // soft-archive a price book

module.exports = router;
