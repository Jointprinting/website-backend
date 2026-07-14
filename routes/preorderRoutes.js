// routes/preorderRoutes.js — OWNER management of preorder links. The public
// commit page rides publicPreorderRoutes (token-gated, no auth), mirroring
// how approval/portal/lookbook split their admin vs public doors.
const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { createPreorder, listPreorders, updatePreorder } = require('../controllers/preorders');

router.use(requireAdmin);
router.get('/', listPreorders);
router.post('/', createPreorder);
router.patch('/:id', updatePreorder);

module.exports = router;
