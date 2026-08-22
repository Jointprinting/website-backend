// routes/clientErrorRoutes.js
//
// Browser crashes, reported back. Mounted at /api/client-errors.
//
// The REPORT route is deliberately public. It has to be: the crash it reports
// may have taken down the app that would otherwise have carried a token, and the
// two routes where that matters most — /approve and /lookbook — are used by
// clients who have no login at all.
//
// So it is bounded rather than trusted: its own tight rate limit (separate from
// the general one, because a page in a crash loop is exactly the shape of a
// flood), a small body cap, and an upsert-by-fingerprint write that increments
// instead of inserting. Everything READ is owner-only.

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { requireOwner } = require('../middleware/auth');
const { report, listErrors, resolveError } = require('../controllers/clientErrors');

// A crashing page can fire the same report repeatedly. Generous enough for a
// genuine burst on one page load, tight enough that a loop can't hammer the API.
const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  // Never answer an error reporter with an error — a 429 body would just be one
  // more thing for a broken page to fail on.
  handler: (_req, res) => res.status(204).end(),
});

// PUBLIC. 64kb is well past a message plus a truncated stack.
router.post('/', reportLimiter, express.json({ limit: '64kb' }), report);

// OWNER-only from here down.
router.use(requireOwner);
router.get('/', listErrors);
router.post('/:id/resolve', express.json(), resolveError);

module.exports = router;
