const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const poCtl = require('../controllers/purchaseOrders');
const {
  listOrders, listProjects, getOrder, createOrder, updateOrder, deleteOrder,
  seedHistorical, nextNumbers, uploadFile, deleteFile, serveFile,
  dashboard, attention, createFromSubmission, mockupHealth, duplicateOrder, analytics, clientsSummary,
  cleanupCandidates, cleanupDelete, mergeCompany, autoLinkMockups, assignMockupNumber,
  createOrGetProjectForCompany,
} = require('../controllers/orders');
const { ensureApprovalToken, sendApprovalLink, publishConfirmation, updateTracking, initTracking } = require('../controllers/approval');
const { confirmationPdf } = require('../controllers/confirmationPdf');
const vendorRebuild = require('../controllers/vendorRebuild');

router.use(requireAdmin);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, 'uploads/'),
  filename:    (_req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^\w.\-]/g, '_')),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/seed-historical',           seedHistorical);
router.post('/from-submission/:submissionId', createFromSubmission);
// LEAD -> QUOTE handoff: create-or-get the working project for a CRM company that
// just entered "quoting". Idempotent (reuses a live project), assigns the next
// project # otherwise. STATIC path, declared above '/:id'. Admin-only via
// router.use(requireAdmin) above.
router.post('/for-company',               createOrGetProjectForCompany);
router.post('/:id/approval-link',         ensureApprovalToken);
router.post('/:id/approval-link/send',    sendApprovalLink);
// "Push to client": flip the finalized confirmation live on the existing link.
router.post('/:id/confirmation/publish',  publishConfirmation);
router.patch('/:id/tracking',             updateTracking);
router.post('/:id/tracking/init',         initTracking);
router.post('/:id/duplicate',             duplicateOrder);
router.get('/cleanup-candidates',         cleanupCandidates);
router.post('/cleanup-delete',            cleanupDelete);
router.post('/merge-company',             mergeCompany);
router.post('/mockups/auto-link',         autoLinkMockups);
router.get('/dashboard',                  dashboard);
router.get('/attention',                  attention);
router.get('/analytics',                  analytics);
router.get('/clients-summary',            clientsSummary);
router.get('/mockup-health',              mockupHealth);
router.get('/next-numbers',               nextNumbers);
router.get('/projects',                   listProjects);
// Must stay above GET '/:id' — a single-segment path, so '/vendors' would
// otherwise be captured as an order id and 500 on the cast.
router.get('/vendors',                    poCtl.listVendors);
// Vendor dedup + merge + typeahead. These STATIC two-segment paths MUST be
// registered before '/vendors/:id' so 'duplicates'/'search'/'merge' aren't read
// as a vendor id. Admin-only (router.use(requireAdmin) above) — cost data never
// leaks client-side.
router.get('/vendors/duplicates',         poCtl.vendorDuplicates);
router.get('/vendors/search',             poCtl.searchVendors);
router.post('/vendors/merge',             poCtl.mergeVendors);
// Owner-triggered "Rebuild printers from Drive" reconcile (preview → confirm;
// idempotent; reversible; archive-not-delete; preserves the Happy-Leaf in-app PO).
// STATIC '/vendors/rebuild/*' paths — MUST stay above '/vendors/:id' so 'rebuild'
// isn't captured as a vendor id. Admin-only (router.use(requireAdmin) above).
router.get('/vendors/rebuild/preview',    vendorRebuild.rebuildPreview);
router.post('/vendors/rebuild/preview',   vendorRebuild.rebuildPreview);
router.post('/vendors/rebuild/apply',     vendorRebuild.rebuildApply);
router.post('/vendors/rebuild/revert',    vendorRebuild.rebuildRevert);
router.get('/vendors/rebuild/status',     vendorRebuild.rebuildStatus);
// Vendor (printer/supplier) detail card + edits. Two-segment paths, so they don't
// collide with '/:id'; grouped here with the other vendor routes for clarity.
router.get('/vendors/:id',                poCtl.getVendor);
router.patch('/vendors/:id',              poCtl.updateVendor);
// Same reason: keep above '/:id' so 'po-cost-history' isn't read as an order id.
router.get('/po-cost-history',            poCtl.poCostHistory);
// Read-only "next PO # for this vendor" peek (no counter consumed). Above '/:id'.
router.get('/po-next-number',             poCtl.nextPoNumber);
router.get('/',                           listOrders);
router.get('/:id',                        getOrder);
router.post('/',                          createOrder);
router.put('/:id',                        updateOrder);
router.delete('/:id',                     deleteOrder);
router.post('/:id/confirmation/pdf',      confirmationPdf);
router.get('/:id/pos',                    poCtl.listPos);
router.post('/:id/pos',                   poCtl.createPo);
router.post('/:id/pos/from-confirmation',  poCtl.createPosFromConfirmation);
router.put('/pos/:poId',                  poCtl.updatePo);
router.delete('/pos/:poId',               poCtl.deletePo);
router.post('/pos/:poId/pdf',             poCtl.poPdf);
router.post('/:id/mockups/assign',        assignMockupNumber);
router.post('/:id/files', upload.single('file'), uploadFile);
router.get('/:id/files/:filename',        serveFile);
router.delete('/:id/files/:filename',     deleteFile);

module.exports = router;
