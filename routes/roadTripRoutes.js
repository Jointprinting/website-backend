// routes/roadTripRoutes.js
//
// All road-trip endpoints sit behind requireAdmin — this is internal sales/
// recon data, never exposed publicly. Place searches don't need to be admin
// strictly speaking, but since they cost real Google money (after the free
// tier) we want auth so random visitors can't run up the bill.

const express = require('express');
const router = express.Router();

const {
  searchDispensaries,
  searchCoffee,
  searchNpsParks,
  searchCampgrounds,
} = require('../controllers/placeSearch');

const {
  listLeads, createLead, updateLead, deleteLead,
  listDenylist, addDenylist, removeDenylist,
} = require('../controllers/roadTripLead');

const { requireAdmin } = require('../middleware/auth');

// All endpoints admin-only.
router.use(requireAdmin);

// ── Place search proxies ────────────────────────────────────────────────────
router.get('/search/dispensaries', searchDispensaries);
router.get('/search/coffee',       searchCoffee);
router.get('/search/parks',        searchNpsParks);
router.get('/search/campgrounds',  searchCampgrounds);

// ── Leads ──────────────────────────────────────────────────────────────────
router.get('/leads',        listLeads);
router.post('/leads',       createLead);
router.put('/leads/:id',    updateLead);
router.delete('/leads/:id', deleteLead);

// ── Denylist ───────────────────────────────────────────────────────────────
router.get('/denylist',            listDenylist);
router.post('/denylist',           addDenylist);
router.delete('/denylist/:placeId', removeDenylist);

module.exports = router;
