const express = require('express');
const router = express.Router();
const { publicGetProject, publicApprove, publicRequestChanges, publicSelectOptions } = require('../controllers/approval');

// All token-gated — no admin auth. Token check is in the controller.
router.get('/projects/:id',              publicGetProject);
router.post('/projects/:id/select',      publicSelectOptions);
router.post('/projects/:id/approve',     publicApprove);
router.post('/projects/:id/feedback',    publicRequestChanges);

module.exports = router;
