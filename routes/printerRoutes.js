// routes/printerRoutes.js — owner-only printer network (quoter picker + pricing).
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  listPrinters, getPrinter,
  createPrinter, updatePrinter, putCatalogSection, extractCatalogSection, archiveCatalogSection,
} = require('../controllers/printers');

router.use(requireAdmin);              // owner-only — the whole printer network
router.get('/', listPrinters);
router.post('/', createPrinter);        // add a printer (no committed JSON needed)
router.get('/:key', getPrinter);
router.patch('/:key', updatePrinter);   // edit meta / contacts / mark pricing reviewed
// Read a printer's price sheet and PROPOSE a section — writes NOTHING. The owner
// reviews the proposal and then confirms through the PUT above. In memory: the
// bytes go straight to the reader and are never written to the dyno's disk.
router.post('/:key/catalog/:section/extract',
  multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } }).single('file'),
  extractCatalogSection);

router.put('/:key/catalog/:section', putCatalogSection);      // create/replace a price book
router.delete('/:key/catalog/:section', archiveCatalogSection); // soft-archive a price book

module.exports = router;
