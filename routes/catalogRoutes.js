// routes/catalogRoutes.js
//
// Catalog router. Public endpoints serve the published list and stream PDFs;
// admin endpoints are gated by requireAdmin and accept multipart uploads via
// multer's in-memory storage (we stream straight to GridFS, so writing to
// disk first would be wasted work).

const express = require('express');
const multer = require('multer');

const {
  listCatalogs,
  listAllCatalogs,
  getCatalog,
  streamPdf,
  createCatalog,
  updateCatalog,
  replaceCatalogPdf,
  reorderCatalogs,
  deleteCatalog,
  seedDefaults,
} = require('../controllers/catalog');

const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// 30 MB cap — your current largest catalog is 18 MB, so this leaves room.
// PDFs only; anything else gets rejected with a clear error.
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('Only PDF files are allowed.'));
    }
    cb(null, true);
  },
});

// ── Public reads ─────────────────────────────────────────────────────────────
router.get('/', listCatalogs);
// Order matters: /all and /:id/pdf must come before /:id so Express doesn't
// match those paths as ids.
router.get('/all', requireAdmin, listAllCatalogs);
router.get('/:id/pdf', streamPdf);
router.get('/:id', getCatalog);

// ── Admin writes ─────────────────────────────────────────────────────────────
router.post('/seed',       requireAdmin, seedDefaults);
router.post('/',           requireAdmin, pdfUpload.single('pdf'), createCatalog);
router.put('/reorder',     requireAdmin, reorderCatalogs);
router.put('/:id',         requireAdmin, updateCatalog);
router.put('/:id/pdf',     requireAdmin, pdfUpload.single('pdf'), replaceCatalogPdf);
router.delete('/:id',      requireAdmin, deleteCatalog);

// Multer errors land here as plain errors; surface a clear message instead
// of the default HTML 500 page.
router.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ message: 'PDF too large (max 30 MB).' });
  }
  if (err && /Only PDF files/.test(err.message)) {
    return res.status(400).json({ message: err.message });
  }
  if (err) {
    console.error('[catalog router] error:', err);
    return res.status(500).json({ message: 'Server error.' });
  }
});

module.exports = router;
