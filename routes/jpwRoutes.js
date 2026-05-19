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
  exportCsv, bulkStatus,
  searchPlaces, auditOneLead, auditBatch, getUsage,
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
router.post('/audit-batch',  auditBatch);
router.post('/search/places', searchPlaces);

// CRUD + per-lead actions
router.get('/leads',           listLeads);
router.post('/leads',          createLead);
router.get('/leads/:id',       getLead);
router.put('/leads/:id',       updateLead);
router.delete('/leads/:id',    deleteLead);
router.post('/leads/:id/audit', auditOneLead);

module.exports = router;
