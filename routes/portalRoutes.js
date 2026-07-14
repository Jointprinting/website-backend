// routes/portalRoutes.js — PUBLIC client-portal read. No auth middleware
// (mirrors publicApprovalRoutes): the magic token in the path is the gate,
// validated in the controller against Client.portalToken.
const express = require('express');
const router = express.Router();
const { getPortal } = require('../controllers/portal');

router.get('/:token', getPortal);

module.exports = router;
