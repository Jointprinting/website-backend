// routes/scriptVersionRoutes.js
const express = require('express');
const router = express.Router();

const { listAll, create, remove } = require('../controllers/scriptVersion');
const { requireAdmin } = require('../middleware/auth');

// All endpoints require studio auth — these are admin-only edits.
router.get('/',     requireAdmin, listAll);
router.post('/',    requireAdmin, create);
router.delete('/:id', requireAdmin, remove);

module.exports = router;
