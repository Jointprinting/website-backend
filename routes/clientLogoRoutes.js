const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { listLogos, upsertLogo, deleteLogo, inlineReport, migrateInline } = require('../controllers/clientLogos');

router.use(requireAdmin);

// Legacy logos uploaded before R2 was configured still hold their full base64
// inline, and listLogos returns every logo in one response. Report the backlog,
// then move it on an explicit confirm. Registered above '/:companyKey' so
// 'inline' can't be read as a company key.
router.get('/inline',          inlineReport);
router.post('/inline/migrate', migrateInline);
router.get('/',                listLogos);
router.post('/',               upsertLogo);
router.delete('/:companyKey',  deleteLogo);

module.exports = router;
