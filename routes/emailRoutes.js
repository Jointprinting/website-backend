const express = require('express');
const router = express.Router();

const { sendContactEmail } = require('../controllers/email');

router.post("/send-contact", sendContactEmail);

module.exports = router;