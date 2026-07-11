// routes/socialPostRoutes.js — the owner's Content planner (/api/social).
// Owner-only; there is no public surface (posts publish on the platforms
// themselves, not through us).

const express = require('express');
const router = express.Router();

const { listPosts, createPost, patchPost, addStat } = require('../controllers/socialPosts');
const { requireAdmin } = require('../middleware/auth');

router.use(requireAdmin);

router.get  ('/posts',           listPosts);
router.post ('/posts',           createPost);
router.patch('/posts/:id',       patchPost);
router.post ('/posts/:id/stats', addStat);

module.exports = router;
