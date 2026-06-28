const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { listItems, saveItem, deleteItem, deleteByRemoteId } = require('../controllers/studioLibrary');
const { lookbookPdf } = require('../controllers/lookbookPdf');

router.use(requireAdmin);

router.get('/library/:store',             listItems);
router.post('/library/:store',            saveItem);
router.delete('/library/item/:id',        deleteItem);
router.delete('/library/remote/:remoteId', deleteByRemoteId);
// Owner-built, client-branded lookbook deck (pdfkit). POST so the deck (ordered
// mockup ids + title/options) rides in the body; streams the PDF back.
router.post('/lookbook/pdf',              lookbookPdf);

module.exports = router;
