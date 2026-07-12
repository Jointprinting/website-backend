// routes/promoCatalogRoutes.js
//
// Promo catalog router — owner-only (requireAdmin). The /scan endpoint takes a
// multipart PDF upload (multer in-memory + a %PDF magic-bytes guard, same as the
// catalog router) and returns AI-scanned promo items for review; the rest are
// plain JSON CRUD the Quoter's promo picker reads from.

const express = require('express');
const multer = require('multer');

const { scanPdf, list, create, update, remove } = require('../controllers/promoCatalog');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') return cb(new Error('Only PDF files are allowed.'));
    cb(null, true);
  },
});

// Magic-bytes check — a spoofed Content-Type can't get past this. Every real PDF
// starts with the ASCII bytes `%PDF` (0x25 0x50 0x44 0x46).
function requirePdfMagic(req, res, next) {
  if (!req.file || !req.file.buffer) return res.status(400).json({ message: 'Attach a PDF to scan.' });
  const buf = req.file.buffer;
  if (buf.length < 4 || buf[0] !== 0x25 || buf[1] !== 0x50 || buf[2] !== 0x44 || buf[3] !== 0x46) {
    return res.status(400).json({ message: 'That file is not a real PDF (header check failed). Re-save it as PDF and try again.' });
  }
  next();
}

router.get('/', requireAdmin, list);
router.post('/scan', requireAdmin, pdfUpload.single('pdf'), requirePdfMagic, scanPdf);
router.post('/', requireAdmin, create);
router.put('/:id', requireAdmin, update);
router.delete('/:id', requireAdmin, remove);

// Surface multer errors as clean JSON instead of the default HTML 500.
router.use((err, _req, res, _next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'PDF too large (max 30 MB).' });
  if (err && /Only PDF files/.test(err.message)) return res.status(400).json({ message: err.message });
  if (err) { console.error('[promo-catalog router] error:', err); return res.status(500).json({ message: 'Server error.' }); }
});

module.exports = router;
