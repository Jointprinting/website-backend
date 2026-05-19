// routes/submissionRoutes.js
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  listSubmissions,
  getSubmission,
  updateSubmission,
  deleteSubmission,
  getUnseenCount,
  markAllSeen,
} = require('../controllers/submissions');

// All submission endpoints are admin-only.
router.use(requireAdmin);

router.get('/unseen-count',   getUnseenCount);
router.post('/mark-all-seen', markAllSeen);

router.get('/',        listSubmissions);
router.get('/:id',     getSubmission);
router.patch('/:id',   updateSubmission);
router.delete('/:id',  deleteSubmission);

module.exports = router;
