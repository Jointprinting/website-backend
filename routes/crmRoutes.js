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
  getPipeline,
  getDashboard,
  getOne,
  patchOne,
  importRows,
  getDuplicates,
  mergeCompanies,
  archiveCompanies,
  unarchiveCompanies,
  deleteLogEntry,
  archiveOne,
  unarchiveOne,
} = require('../controllers/crm');

router.use(requireAdmin);

router.get('/',          listCrm);
router.get('/today',     getToday);
router.get('/calendar',  getCalendar);
router.get('/pipeline',  getPipeline);
router.get('/dashboard', getDashboard);
router.get('/duplicates', getDuplicates);
router.post('/import',   importRows);
router.post('/merge',    mergeCompanies);
router.post('/archive',  archiveCompanies);
router.post('/unarchive', unarchiveCompanies);

router.get('/:companyKey',   getOne);
router.patch('/:companyKey', patchOne);
// Single-card actions the detail page calls directly (all soft / reversible):
//   • archive / unarchive THIS one company (owner: "fine removing their card")
//   • delete ONE log entry from the card (owner: "i cant delete notes")
router.post('/:companyKey/archive',   archiveOne);
router.post('/:companyKey/unarchive', unarchiveOne);
router.delete('/:companyKey/log/:entryId', deleteLogEntry);

module.exports = router;
