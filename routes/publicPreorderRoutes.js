// routes/publicPreorderRoutes.js — PUBLIC preorder page + commit. No auth
// middleware (mirrors portalRoutes/publicApprovalRoutes): the token in the
// path is the gate, validated in the controller.
const express = require('express');
const router = express.Router();
const { getPublicPreorder, commitPreorder } = require('../controllers/preorders');

router.get('/:token', getPublicPreorder);
router.post('/:token/commit', commitPreorder);

module.exports = router;
