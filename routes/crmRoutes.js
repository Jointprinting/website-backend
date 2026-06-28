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
  matchCandidates,
} = require('../controllers/crm');
const {
  reconcilePreview,
  reconcileApply,
  reconcileRevert,
  reconcileStatus,
} = require('../controllers/crmReconcile');
const {
  cleanupPreview,
  cleanupApply,
  cleanupRevert,
  cleanupStatus,
} = require('../controllers/dataCleanup');

router.use(requireAdmin);

router.get('/',          listCrm);
router.get('/today',     getToday);
router.get('/calendar',  getCalendar);
router.get('/pipeline',  getPipeline);
router.get('/dashboard', getDashboard);
router.get('/duplicates', getDuplicates);
// Dedup-on-entry: top existing candidates for a typed name (SUGGEST-only, never
// merges/blocks). Fixed path, declared before the dynamic /:companyKey.
router.get('/match',     matchCandidates);
router.post('/import',   importRows);
router.post('/merge',    mergeCompanies);
router.post('/archive',  archiveCompanies);
router.post('/unarchive', unarchiveCompanies);

// ── Owner-triggered data reconcile (preview → confirm; idempotent; reversible).
// Fixed paths, declared BEFORE the dynamic /:companyKey so they aren't swallowed.
//   GET/POST /reconcile/preview  → the plan (no writes)
//   POST     /reconcile/apply    → execute the plan (requires { confirm: true })
//   POST     /reconcile/revert   → undo a prior apply batch by id
//   GET      /reconcile/status   → has it ever been applied? (auto-hide the entry)
router.get('/reconcile/preview',  reconcilePreview);
router.post('/reconcile/preview', reconcilePreview);
router.post('/reconcile/apply',   reconcileApply);
router.post('/reconcile/revert',  reconcileRevert);
router.get('/reconcile/status',   reconcileStatus);

// ── Owner-run "Fix data" cleanup (preview → confirm; reversible). Surfaces only
// genuine issues (orphaned orders, contact-polluted names, mis-keyed receipts).
// Fixed paths, declared BEFORE the dynamic /:companyKey so they aren't swallowed.
router.get('/data-cleanup/preview',  cleanupPreview);
router.post('/data-cleanup/preview', cleanupPreview);
router.post('/data-cleanup/apply',   cleanupApply);
router.post('/data-cleanup/revert',  cleanupRevert);
router.get('/data-cleanup/status',   cleanupStatus);

router.get('/:companyKey',   getOne);
router.patch('/:companyKey', patchOne);
// Single-card actions the detail page calls directly (all soft / reversible):
//   • archive / unarchive THIS one company (owner: "fine removing their card")
//   • delete ONE log entry from the card (owner: "i cant delete notes")
router.post('/:companyKey/archive',   archiveOne);
router.post('/:companyKey/unarchive', unarchiveOne);
router.delete('/:companyKey/log/:entryId', deleteLogEntry);

module.exports = router;
