// routes/publicPreorderRoutes.js — PUBLIC preorder page + commit. No auth
// middleware (mirrors portalRoutes/publicApprovalRoutes): the token in the
// path is the gate, validated in the controller.
const express = require('express');
const router = express.Router();
const { getPublicPreorder, commitPreorder, getClientPreorder } = require('../controllers/preorders');

// The client/organizer view — registered BEFORE '/:token' so it isn't swallowed
// as a token literally named "client".
router.get('/client/:clientToken', getClientPreorder);
router.get('/:token', getPublicPreorder);
router.post('/:token/commit', commitPreorder);

module.exports = router;
