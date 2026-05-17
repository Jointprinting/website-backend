// routes/siteSettingRoutes.js
//
// GET is public so the marketing site can read the toast config without
// authentication. PUT is admin-only.

const express = require('express');
const { getSetting, setSetting } = require('../controllers/siteSetting');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

router.get('/:key',  getSetting);
router.put('/:key',  requireAdmin, setSetting);

module.exports = router;
