const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { listLogos, upsertLogo, deleteLogo } = require('../controllers/clientLogos');

router.use(requireAdmin);

router.get('/',                listLogos);
router.post('/',               upsertLogo);
router.delete('/:companyKey',  deleteLogo);

module.exports = router;
