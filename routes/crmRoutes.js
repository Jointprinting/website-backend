// routes/crmRoutes.js
//
// The unified CRM API. Everything here is internal sales data, so the whole
// router sits behind requireAdmin. Mounted at /api/crm in server.js.
//
// NOTE on route order: the fixed sub-paths (/today, /calendar, /import) are
// declared BEFORE the dynamic /:companyKey so they're never swallowed by it.

const express = require('express');
const router  = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  listCrm,
  getToday,
  getCalendar,
  getOne,
  patchOne,
  importRows,
} = require('../controllers/crm');

router.use(requireAdmin);

router.get('/',          listCrm);
router.get('/today',     getToday);
router.get('/calendar',  getCalendar);
router.post('/import',   importRows);

router.get('/:companyKey',   getOne);
router.patch('/:companyKey', patchOne);

module.exports = router;
