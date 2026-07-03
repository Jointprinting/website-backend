// routes/roadTripRoutes.js
//
// All road-trip endpoints sit behind requireAdmin — this is internal sales/
// recon data, never exposed publicly. Place searches don't need to be admin
// strictly speaking, but since they cost real Google money (after the free
// tier) we want auth so random visitors can't run up the bill.

const express = require('express');
const router = express.Router();

const { searchDispensaries } = require('../controllers/placeSearch');

const {
  listLeads, createLead, updateLead, deleteLead,
  listDenylist, addDenylist, removeDenylist,
} = require('../controllers/roadTripLead');

const {
  listDispensaries, coverage, ingest, enrich, geocode, sweep, hide, rechain, suggest,
} = require('../controllers/dispensary');

const {
  getCurrent, addStop, removeStop, patchStop, optimize, patchRun, completeRun,
} = require('../controllers/fieldRun');

const { requireAdmin } = require('../middleware/auth');

// All endpoints admin-only.
router.use(requireAdmin);

// ── Nationwide dispensary database ──────────────────────────────────────────
router.get   ('/dispensaries',              listDispensaries);
router.get   ('/dispensaries/coverage',     coverage);
router.post  ('/dispensaries/ingest/:state', ingest);
router.post  ('/dispensaries/enrich',       enrich);
router.post  ('/dispensaries/geocode',      geocode);
router.post  ('/dispensaries/sweep',        sweep);
router.post  ('/dispensaries/rechain',      rechain);
router.post  ('/dispensaries/:id/hide',     hide);

// ── Today's Run ──────────────────────────────────────────────────────────────
router.get   ('/suggest',           suggest);   // best nearby prospects to visit
router.get   ('/run',               getCurrent);
router.patch ('/run',               patchRun);
router.post  ('/run/stops',         addStop);
router.delete('/run/stops/:stopId', removeStop);
router.patch ('/run/stops/:stopId', patchStop);
router.post  ('/run/optimize',      optimize);
router.post  ('/run/complete',      completeRun);

// ── Live place search (legacy fallback — the map now reads the DB) ──────────
router.get('/search/dispensaries', searchDispensaries);

// ── Leads (custom pins: friends / printers / waypoints) ─────────────────────
router.get('/leads',        listLeads);
router.post('/leads',       createLead);
router.put('/leads/:id',    updateLead);
router.delete('/leads/:id', deleteLead);

// ── Denylist ───────────────────────────────────────────────────────────────
router.get('/denylist',            listDenylist);
router.post('/denylist',           addDenylist);
router.delete('/denylist/:placeId', removeDenylist);

module.exports = router;
