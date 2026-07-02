// routes/outreachRoutes.js
//
// Cold-outreach API. Mounted at /api/outreach in server.js.
//
// TWO PUBLIC endpoints live at the top, BEFORE requireAdmin: the unsubscribe
// link and the open pixel that outreach emails embed. Both are keyed by the
// enrollment's unguessable random token (no ids, no enumeration), and neither
// exposes any data — they only flip that one enrollment's own state.
// Everything below them is internal sales tooling behind requireAdmin.

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const {
  getOverview,
  createCampaign,
  updateCampaign,
  getCampaign,
  getCandidates,
  enrollCompanies,
  getQueue,
  markReplied,
  stopEnrollment,
  runTickNow,
  trackOpen,
  unsubscribe,
  getFinderStatus,
  findLeads,
  setAutoAdvance,
  runAutoNow,
  getAnalytics,
  bounceWebhook,
} = require('../controllers/outreach');

// ── Public (token-keyed, embedded in the emails themselves) ──
router.get('/t/:token/open.png', trackOpen);
router.get('/u/:token', unsubscribe);
router.post('/u/:token', unsubscribe);   // one-click List-Unsubscribe (RFC 8058)
// Provider bounce/complaint webhook — self-guarded by OUTREACH_BOUNCE_SECRET.
router.post('/bounce', bounceWebhook);

// ── Admin ──
router.use(requireAdmin);

router.get('/overview',   getOverview);
router.get('/analytics',  getAnalytics);
router.get('/candidates', getCandidates);
router.get('/queue',      getQueue);
router.post('/run-tick',  runTickNow);

// Free dispensary lead finder (OSM discovery → website email scrape → import).
router.get('/find-leads/status',   getFinderStatus);
router.post('/find-leads',         findLeads);
router.post('/find-leads/auto',    setAutoAdvance);  // toggle auto-pilot / jump frontier
router.post('/find-leads/auto/run', runAutoNow);     // run one frontier tick now

router.post('/campaigns',            createCampaign);
router.get('/campaigns/:id',         getCampaign);
router.patch('/campaigns/:id',       updateCampaign);
router.post('/campaigns/:id/enroll', enrollCompanies);

router.post('/enrollments/:id/replied', markReplied);
router.post('/enrollments/:id/stop',    stopEnrollment);

module.exports = router;
