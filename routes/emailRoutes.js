// routes/emailRoutes.js
const express = require('express');
const router = express.Router();

const { sendContactEmail } = require('../controllers/email');

router.post('/send-contact', sendContactEmail);
// /send-mockup-request retired with the public /customize page — the Contact form
// (send-contact) is the one quote/mockup path, so there's one validation rule and
// one submission pipeline feeding the Studio inbox.

module.exports = router;
