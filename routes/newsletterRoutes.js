// routes/newsletterRoutes.js — the Studio client newsletter (/api/newsletter).
// Admin CRUD + send; the open pixel is public (mounted separately in server.js).

const express = require('express');
const router = express.Router();

const {
  listNewsletters, createNewsletter, getNewsletter, patchNewsletter,
  uploadFile, previewAudience, sendTest, sendNewsletter,
} = require('../controllers/newsletter');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

router.get  ('/',                listNewsletters);
router.post ('/',                createNewsletter);
router.get  ('/:id',             getNewsletter);
router.patch('/:id',             patchNewsletter);
router.post ('/upload',          uploadFile);
router.get  ('/:id/audience',    previewAudience);
router.post ('/:id/test',        sendTest);
router.post ('/:id/send',        sendNewsletter);

module.exports = router;
