// routes/emailRoutes.js
const express = require('express');
const multer = require('multer');
const router = express.Router();

const { sendContactEmail, sendWebworksLead, sendAtomLead } = require('../controllers/email');

// Multipart parsing lives on the ROUTES, not on the /api/email prefix.
//
// It used to be mounted prefix-wide in server.js, which meant multer ran BEFORE
// route matching: a POST to /api/email/anything wrote up to 10 x 25MB to uploads/
// and then 404'd, so the handler that deletes those files (controllers/email
// cleanupFiles) never ran and the bytes were orphaned forever on a public,
// unauthenticated route. Mounted here, an unmatched path 404s before a single
// byte is written.
//
// No fileFilter on purpose: the quote form tells clients "Any file type accepted"
// and these are client artwork (AI/EPS/PSD/ZIP are normal). The files are never
// executed or served — they are emailed and then deleted.
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, 'uploads/'),
  filename:    (_req, file, cb) => cb(null, Date.now() + '-' + file.originalname.replace(/[^\w.\-]/g, '_')),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024, files: 10 } });
const attachments = upload.array('files', 10);

router.post('/send-contact', attachments, sendContactEmail);
// /send-mockup-request retired with the public /customize page — the Contact form
// (send-contact) is the one quote/mockup path, so there's one validation rule and
// one submission pipeline feeding the Studio inbox.

// JP Webworks website leads (from /webworks/start). Same ContactSubmission
// pipeline + Studio inbox, tagged source:'webworks'; inherits the /api/email
// contactLimiter + multipart parsing mounted in server.js.
router.post('/webworks-lead', attachments, sendWebworksLead);

// JP Atom studio leads (from /atom/contact). Same pipeline, source:'atom'.
router.post('/atom-lead', attachments, sendAtomLead);

module.exports = router;
