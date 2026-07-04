// routes/authRoutes.js
const express = require('express');
const rateLimit = require('express-rate-limit');
const { studioLogin, verifyToken } = require('../controllers/auth');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// At most 10 login attempts per IP per 15 min — defense in depth on top of
// the per-account lockout in the controller.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts. Try again in 15 minutes.' },
});

router.post('/studio-login', loginLimiter, studioLogin);
// Any authenticated account (owner OR agent) can verify its token on app load —
// the response carries the role so the client renders the right surface.
router.get('/verify', requireAuth, verifyToken);

module.exports = router;
