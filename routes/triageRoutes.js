// routes/triageRoutes.js
//
// Gmail Reply Triage API. Mounted at /api/triage in server.js. Detection-only
// inbox for buyer replies to cold outreach — no public endpoints, everything is
// behind requireAdmin (the same Studio auth as the rest of the sales tooling).

const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/auth');
const { listReplies, addReplies, updateStatus, syncGmail } = require('../controllers/replyTriage');

router.use(requireAdmin);

router.get('/replies', listReplies);
router.post('/replies', addReplies);       // add one ({...}) or many ({ replies: [...] })
router.patch('/replies/:id', updateStatus); // { status }
router.post('/sync', syncGmail);            // Gmail sync seam (env-gated no-op in V1)

module.exports = router;
