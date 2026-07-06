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
  launchCampaign,
  getCampaign,
  getCandidates,
  enrollCompanies,
  getQueue,
  markReplied,
  stopEnrollment,
  unenrollAll,
  resetCampaign,
  deleteCampaign,
  setAutoEnroll,
  runTickNow,
  sendTest,
  recheckAuthNow,
  trackOpen,
  unsubscribe,
  getFinderStatus,
  findLeads,
  runAutoNow,
  getAnalytics,
  bounceWebhook,
  recoverSenderFailures,
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
router.post('/recover-sends', recoverSenderFailures); // requeue leads dropped by a sender-side error
router.post('/test-send', sendTest);        // first-run wizard: send a sample to yourself
router.post('/auth-recheck', recheckAuthNow); // force-refresh SPF/DKIM/DMARC classification

// Free dispensary lead engine (OSM discovery → website email scrape → import).
// Always on — no toggle; it milks each state dry and advances on its own.
router.get('/find-leads/status',    getFinderStatus);
router.post('/find-leads',          findLeads);      // manual one-state sweep (API-only)
router.post('/find-leads/auto/run', runAutoNow);     // "Refill now" — force a sweep

router.post('/campaigns',            createCampaign);
router.get('/campaigns/:id',         getCampaign);
router.patch('/campaigns/:id',       updateCampaign);
router.post('/campaigns/:id/launch', launchCampaign);
router.post('/campaigns/:id/enroll', enrollCompanies);
router.post('/campaigns/:id/unenroll-all', unenrollAll);
router.post('/campaigns/:id/reset', resetCampaign); // full fresh start — clears the roster
router.delete('/campaigns/:id', deleteCampaign);    // remove a campaign entirely
router.post('/campaigns/:id/auto-enroll', setAutoEnroll);

router.post('/enrollments/:id/replied', markReplied);
router.post('/enrollments/:id/stop',    stopEnrollment);

module.exports = router;
