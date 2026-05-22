const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  listOrders, listProjects, getOrder, createOrder, updateOrder, deleteOrder,
  seedHistorical, nextNumbers, uploadFile, deleteFile, serveFile,
  dashboard, createFromSubmission, mockupHealth, duplicateOrder, analytics, clientsSummary,
  cleanupCandidates, cleanupDelete, mergeCompany, autoLinkMockups,
} = require('../controllers/orders');
const { ensureApprovalToken } = require('../controllers/approval');

router.use(requireAdmin);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, 'uploads/'),
  filename:    (_req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^\w.\-]/g, '_')),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

router.post('/seed-historical',           seedHistorical);
router.post('/from-submission/:submissionId', createFromSubmission);
router.post('/:id/approval-link',         ensureApprovalToken);
router.post('/:id/duplicate',             duplicateOrder);
router.get('/cleanup-candidates',         cleanupCandidates);
router.post('/cleanup-delete',            cleanupDelete);
router.post('/merge-company',             mergeCompany);
router.post('/mockups/auto-link',         autoLinkMockups);
router.get('/dashboard',                  dashboard);
router.get('/analytics',                  analytics);
router.get('/clients-summary',            clientsSummary);
router.get('/mockup-health',              mockupHealth);
router.get('/next-numbers',               nextNumbers);
router.get('/projects',                   listProjects);
router.get('/',                           listOrders);
router.get('/:id',                        getOrder);
router.post('/',                          createOrder);
router.put('/:id',                        updateOrder);
router.delete('/:id',                     deleteOrder);
router.post('/:id/files', upload.single('file'), uploadFile);
router.get('/:id/files/:filename',        serveFile);
router.delete('/:id/files/:filename',     deleteFile);

module.exports = router;
