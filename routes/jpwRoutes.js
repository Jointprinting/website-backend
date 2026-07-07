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
const {
  listSites, createSite, getSite, updateSite, deleteSite, generateCopy, getPublicSite, getPublicSiteByDomain,
} = require('../controllers/jpwSites');

// PUBLIC site reads — the ONLY unauthenticated routes here, so they must
// register BEFORE the admin gate. /webworks/p/<slug> preview pages render from
// the slug route; a client's CONNECTED custom domain resolves through the
// domain route (the React app's hostname gate). The controller only serves
// preview/live sites (drafts 404), so nothing half-built is ever reachable.
// NOTE: /sites/public/domain/:host must register before /sites/public/:slug —
// otherwise Express would swallow "domain" as a :slug value.
router.get('/sites/public/domain/:host', getPublicSiteByDomain);
router.get('/sites/public/:slug', getPublicSite);

router.use(requireAdmin);

// ── Websites builder (Studio → JP Webworks → Websites) ────────────────────────
router.get('/sites',        listSites);
router.post('/sites',       createSite);
router.get('/sites/:id',    getSite);
router.put('/sites/:id',    updateSite);
router.delete('/sites/:id', deleteSite);
router.post('/sites/:id/generate', generateCopy); // AI: write the whole site from a brief

// Cold Call Tree state — backend-persisted edits + notes (formerly localStorage)
const { getState: getCcState, updateState: updateCcState } = require('../controllers/coldCallState');
router.get('/cold-call-state', getCcState);
router.put('/cold-call-state', updateCcState);

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
