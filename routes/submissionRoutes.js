// routes/submissionRoutes.js
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  listSubmissions,
  getSubmission,
  updateSubmission,
  deleteSubmission,
} = require('../controllers/submissions');

// All submission endpoints are admin-only.
router.use(requireAdmin);

router.get('/',        listSubmissions);
router.get('/:id',     getSubmission);
router.patch('/:id',   updateSubmission);
router.delete('/:id',  deleteSubmission);

module.exports = router;
