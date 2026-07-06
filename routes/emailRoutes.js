// routes/emailRoutes.js
const express = require('express');
const router = express.Router();

const { sendContactEmail, sendWebworksLead } = require('../controllers/email');

router.post('/send-contact', sendContactEmail);
// /send-mockup-request retired with the public /customize page — the Contact form
// (send-contact) is the one quote/mockup path, so there's one validation rule and
// one submission pipeline feeding the Studio inbox.

// JP Webworks website leads (from /webworks/start). Same ContactSubmission
// pipeline + Studio inbox, tagged source:'webworks'; inherits the /api/email
// contactLimiter + multipart parsing mounted in server.js.
router.post('/webworks-lead', sendWebworksLead);

module.exports = router;
