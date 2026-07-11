// controllers/socialPosts.js
//
// The Content planner's API: the owner's social idea vault + pipeline +
// engagement tracker (frontend: src/screens/studio/ContentTab.js). Plain
// owner-only CRUD with two house rules baked in:
//
//   • NOTHING hard-deletes. "Remove" is archived:true — the whole point of
//     the vault is that an idea can't get deleted randomly.
//   • Stats are APPEND-ONLY snapshots. Each reading (pasted views/likes/
//     comments/shares) is a new point; the series is the growth curve, and a
//     later API integration can append through the same door.
//
// The weekly pace goal (1 LinkedIn + 1 IG a week, adjustable) lives in the
// generic site-settings store under the key `socialPace` — see
// controllers/siteSetting.js — so this controller stays purely about posts.

const SocialPost = require('../models/SocialPost');

const num = (v) => Number(v) || 0;

// Whitelist + clean a write body. Everything the owner can set travels
// through here (create and patch), so a stray field can never land in Mongo
// and sizes stay sane. Returns only the keys present on `body`.
function cleanPostFields(body = {}) {
  const out = {};
  if (body.platform !== undefined) {
    const p = String(body.platform || '').toLowerCase();
    out.platform = SocialPost.PLATFORMS.includes(p) ? p : '';
  }
  if (body.status !== undefined) {
    const s = String(body.status || '').toLowerCase();
    if (SocialPost.POST_STATUSES.includes(s)) out.status = s;
  }
  if (body.title !== undefined) out.title = String(body.title || '').slice(0, 200);
  if (body.body  !== undefined) out.body  = String(body.body  || '').slice(0, 12000);
  if (body.notes !== undefined) out.notes = String(body.notes || '').slice(0, 4000);
  if (body.tags !== undefined) {
    out.tags = (Array.isArray(body.tags) ? body.tags : [])
      .map(t => String(t || '').trim().slice(0, 40)).filter(Boolean).slice(0, 20);
  }
  if (body.refImage !== undefined) {
    const img = String(body.refImage || '');
    // Data URLs only (or clearing) — shrunk client-side; hard cap as a backstop.
    out.refImage = img && img.startsWith('data:') && img.length <= 900 * 1024 ? img : '';
  }
  if (body.postUrl !== undefined) {
    const u = String(body.postUrl || '').trim().slice(0, 500);
    out.postUrl = /^https?:\/\//i.test(u) || u === '' ? u : '';
  }
  if (body.scheduledFor !== undefined) {
    const d = body.scheduledFor ? new Date(body.scheduledFor) : null;
    out.scheduledFor = d && !Number.isNaN(d.getTime()) ? d : null;
  }
  if (body.postedAt !== undefined) {
    const d = body.postedAt ? new Date(body.postedAt) : null;
    out.postedAt = d && !Number.isNaN(d.getTime()) ? d : null;
  }
  return out;
}

// Status → timestamp coupling: flipping to 'posted' stamps postedAt (the
// pace week) unless the owner set an explicit date; archiving stamps
// archivedAt; un-archiving clears it. Mutates and returns `set`.
function applyStatusStamps(set, current = {}, now = new Date()) {
  if (set.status === 'posted' && set.postedAt === undefined && !current.postedAt) {
    set.postedAt = now;
  }
  if (set.archived === true && !current.archived) set.archivedAt = now;
  if (set.archived === false && current.archived) set.archivedAt = null;
  return set;
}

// One pasted stat reading → a clean snapshot. Negative/garbage input clamps
// to 0 so the growth curve can't dip below zero on a typo.
function cleanStatSnapshot(body = {}, now = new Date()) {
  return {
    at: now,
    views:    Math.max(0, num(body.views)),
    likes:    Math.max(0, num(body.likes)),
    comments: Math.max(0, num(body.comments)),
    shares:   Math.max(0, num(body.shares)),
  };
}

// Bound the snapshot series so a doc can't grow unbounded — beyond the cap
// the OLDEST readings roll off (the recent curve is what the tracker shows).
const MAX_SNAPSHOTS = 200;

// GET /api/social/posts?archived=1 — newest-touched first; the tab organizes
// by status client-side. Archived rows only ride along when asked for.
const listPosts = async (req, res) => {
  try {
    const includeArchived = req.query.archived === '1';
    const q = includeArchived ? {} : { archived: { $ne: true } };
    const posts = await SocialPost.find(q).sort({ updatedAt: -1 }).lean();
    res.json({ posts });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/social/posts — capture. Defaults make the quick-add path cheap:
// a bare { title } lands as an unassigned idea.
const createPost = async (req, res) => {
  try {
    const set = applyStatusStamps(cleanPostFields(req.body || {}), {});
    const post = await SocialPost.create(set);
    res.status(201).json({ post });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// PATCH /api/social/posts/:id — partial update, incl. archive/unarchive via
// { archived }. Never deletes anything.
const patchPost = async (req, res) => {
  try {
    const current = await SocialPost.findById(req.params.id).select('archived postedAt').lean();
    if (!current) return res.status(404).json({ message: 'Post not found' });
    const set = cleanPostFields(req.body || {});
    if (req.body && req.body.archived !== undefined) set.archived = req.body.archived === true;
    applyStatusStamps(set, current);
    const post = await SocialPost.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    res.json({ post });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/social/posts/:id/stats — append one engagement reading.
const addStat = async (req, res) => {
  try {
    const snap = cleanStatSnapshot(req.body || {});
    const post = await SocialPost.findByIdAndUpdate(
      req.params.id,
      { $push: { stats: { $each: [snap], $slice: -MAX_SNAPSHOTS } } },
      { new: true },
    ).lean();
    if (!post) return res.status(404).json({ message: 'Post not found' });
    res.json({ post });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

module.exports = {
  listPosts, createPost, patchPost, addStat,
  // exported for tests
  cleanPostFields, applyStatusStamps, cleanStatSnapshot, MAX_SNAPSHOTS,
};
