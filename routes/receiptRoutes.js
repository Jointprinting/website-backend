const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const ctl = require('../controllers/receipts');

// Receipts hold financial data — admin only.
router.use(requireAdmin);

// In-memory upload for the zip / loose-file batch (kept in RAM, streamed to R2).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 50 } });

// Reports / batch first (literal paths before :id).
router.get('/reconcile', ctl.reconcile);
router.post('/bulk-reconcile', ctl.bulkReconcile);
router.post('/batch', upload.array('files', 50), ctl.batch);

router.get('/', ctl.list);
router.post('/', ctl.upload);                 // single receipt (JSON dataURL)
router.get('/:id', ctl.getOne);
router.put('/:id', ctl.update);
router.delete('/:id', ctl.remove);
router.post('/:id/reprocess', ctl.reprocess);
router.post('/:id/confirm', ctl.confirm);

module.exports = router;
