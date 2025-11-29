// routes/emailRoutes.js
const express = require('express');
const router = express.Router();

const { sendContactEmail, sendMockupRequest } = require('../controllers/email');

router.post('/send-contact', sendContactEmail);
router.post('/send-mockup-request', sendMockupRequest);

module.exports = router;
