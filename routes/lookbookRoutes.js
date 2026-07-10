// routes/lookbookRoutes.js — admin CRUD/share for Lookbooks (/api/lookbooks).
// The public, token-gated gallery routes live in publicLookbookRoutes.js.

const express = require('express');
const router = express.Router();

const {
  listLookbooks, createLookbook, getLookbook, patchLookbook,
  shareLookbook, markFeedbackSeen,
} = require('../controllers/lookbooks');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

router.get   ('/',                  listLookbooks);
router.post  ('/',                  createLookbook);
router.get   ('/:id',               getLookbook);
router.patch ('/:id',               patchLookbook);
router.post  ('/:id/share',         shareLookbook);
router.post  ('/:id/feedback/seen', markFeedbackSeen);

module.exports = router;
