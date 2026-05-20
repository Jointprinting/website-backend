// routes/jpwRoutes.js
//
// JP Webworks lead recon — all endpoints admin-only. Discovery (Places /
// audit / Meta) lands here in Phase 2+; this file only wires Phase 1 (CRUD,
// import, scoring, dashboard, export).

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  listLeads, getLead, createLead, updateLead, deleteLead,
  rescoreLeads, importCsv, getDashboardStats, getReferenceData,
  exportCsv, bulkStatus, bulkDelete,
  searchPlaces, sweepPlaces, sweepStatus, sweepStop,
  auditOneLead, auditBatch, getUsage,
  pushOneToSpider, pushBatchToSpider, updateAdSignal,
  runScheduledJob,
} = require('../controllers/jpwLead');

router.use(requireAdmin);

// Reference data — towns, counties, categories, score caps
router.get('/reference', getReferenceData);

// Dashboard counts
router.get('/stats', getDashboardStats);
router.get('/usage', getUsage);

// CSV export (must come before /:id catch-all)
router.get('/export.csv', exportCsv);

// Batch operations
router.post('/import',       importCsv);
router.post('/rescore',      rescoreLeads);
router.post('/bulk-status',  bulkStatus);
router.post('/audit-batch',           auditBatch);
router.post('/search/places',         searchPlaces);
router.post('/search/sweep',          sweepPlaces);
router.get('/search/sweep/status',    sweepStatus);
router.post('/search/sweep/stop',     sweepStop);
router.post('/push-to-spider-batch',  pushBatchToSpider);
router.post('/bulk-delete',           bulkDelete);
router.post('/scheduler/:job/run',    runScheduledJob);

// CRUD + per-lead actions
router.get('/leads',                    listLeads);
router.post('/leads',                   createLead);
router.get('/leads/:id',                getLead);
router.put('/leads/:id',                updateLead);
router.delete('/leads/:id',             deleteLead);
router.post('/leads/:id/audit',          auditOneLead);
router.post('/leads/:id/push-to-spider', pushOneToSpider);
router.post('/leads/:id/ad-signal',       updateAdSignal);

module.exports = router;
