const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { listItems, getByRemoteIds, saveItem, deleteItem, deleteByRemoteId } = require('../controllers/studioLibrary');
const { saveVersion, listVersions, getVersion } = require('../controllers/studioVersions');
const { lookbookPdf } = require('../controllers/lookbookPdf');

router.use(requireAdmin);

router.get('/library/:store',             listItems);
// Full docs for specific remoteIds — the studio's two-phase sync (summary
// list → fetch only what's new/newer) so opening the studio stays fast.
router.get('/library/:store/full',        getByRemoteIds);
router.post('/library/:store',            saveItem);
router.delete('/library/item/:id',        deleteItem);
router.delete('/library/remote/:remoteId', deleteByRemoteId);

// Cloud-durable mockup version history (the studio is local-first; this mirror
// lets a prior version survive a device wipe). List is light; get is the full
// snapshot for a restore.
router.post('/versions',                  saveVersion);
router.get('/versions/:mockupRemoteId',   listVersions);
router.get('/version/:versionRemoteId',   getVersion);
// Owner-built, client-branded lookbook deck (pdfkit). POST so the deck (ordered
// mockup ids + title/options) rides in the body; streams the PDF back.
router.post('/lookbook/pdf',              lookbookPdf);

module.exports = router;
