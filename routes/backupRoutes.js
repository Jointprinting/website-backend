const express = require('express');
const multer  = require('multer');
const path    = require('path');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { status, exportAll, restoreAll } = require('../controllers/backup');

router.use(requireAdmin);

// Restore uploads are big — write to disk, don't keep in memory.
const tmpStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, path.join(__dirname, '..', 'uploads')),
  filename:    (_req, file, cb) => cb(null, `restore-tmp-${Date.now()}-${file.originalname.replace(/[^\w.\-]/g, '_')}`),
});
const upload = multer({ storage: tmpStorage, limits: { fileSize: 500 * 1024 * 1024 } });  // 500 MB cap

router.get('/status',              status);
router.get('/export',              exportAll);
router.post('/restore', upload.single('file'), restoreAll);

module.exports = router;
