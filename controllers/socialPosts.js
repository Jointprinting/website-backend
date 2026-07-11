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
const SocialAccount = require('../models/SocialAccount');
// The Meta Graph plumbing (base URL, wrapped GET, error unwrapping) lives in
// the service — the controller stays thin so a version bump lands in one file.
const { syncInstagram, graphGet, graphErrorMessage } = require('../services/instagramSync');

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

// The account card's read: everything EXCEPT the token itself (an admin JWT
// shouldn't be able to exfiltrate the Meta credential — hasToken + expiry is
// all the UI needs).
const maskAccount = (a) => a && ({
  platform: a.platform, igUserId: a.igUserId, username: a.username,
  followers: a.followers, mediaCount: a.mediaCount, profilePicUrl: a.profilePicUrl,
  lastSyncAt: a.lastSyncAt, lastSyncError: a.lastSyncError,
  hasToken: !!a.accessToken, tokenExpiresAt: a.tokenExpiresAt,
  followerHistory: (a.followerHistory || []).slice(-90),
});
const readMasked = async () => maskAccount(await SocialAccount.findOne({ platform: 'instagram' }).lean()) || null;

// GET /api/social/account — the connected Instagram account (or null).
const getAccount = async (req, res) => {
  try {
    res.json({ account: await readMasked() });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/social/account — connect/refresh Instagram: { accessToken,
// igUserId? }. Three steps, each honest about failure:
//   1. If FACEBOOK_APP_ID/SECRET are configured, exchange the pasted token
//      for a ~60-day long-lived one (best-effort — the pasted token is used
//      as-is when the exchange isn't possible).
//   2. Discover the IG Business user id via /me/accounts when not supplied.
//   3. Validate by reading the profile, then upsert + run a first full sync
//      so the tab lights up immediately.
const connectAccount = async (req, res) => {
  try {
    let token = String((req.body || {}).accessToken || '').trim();
    let igUserId = String((req.body || {}).igUserId || '').trim();
    if (!token) return res.status(400).json({ message: 'Paste the access token first.' });

    let tokenExpiresAt = null;
    if (process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET) {
      try {
        const data = await graphGet('oauth/access_token', {
          grant_type: 'fb_exchange_token',
          client_id: process.env.FACEBOOK_APP_ID,
          client_secret: process.env.FACEBOOK_APP_SECRET,
          fb_exchange_token: token,
        });
        if (data.access_token) {
          token = data.access_token;
          if (data.expires_in) tokenExpiresAt = new Date(Date.now() + data.expires_in * 1000);
        }
      } catch (e) { /* keep the pasted token — exchange is a bonus */ }
    }

    if (!igUserId) {
      try {
        const data = await graphGet('me/accounts', {
          fields: 'name,instagram_business_account{id,username}', access_token: token,
        });
        const page = (data.data || []).find((pg) => pg.instagram_business_account && pg.instagram_business_account.id);
        if (page) igUserId = page.instagram_business_account.id;
      } catch (e) { /* falls through to the explicit error below */ }
      if (!igUserId) {
        return res.status(400).json({
          message: 'Could not find an Instagram Business account on this token — make sure your IG is a Business/Creator account linked to a Facebook Page, or paste the IG user id manually.',
        });
      }
    }

    let prof;
    try {
      prof = await graphGet(igUserId, {
        fields: 'followers_count,media_count,username,profile_picture_url', access_token: token,
      });
    } catch (e) {
      return res.status(400).json({ message: `Instagram rejected the credentials: ${String(graphErrorMessage(e)).slice(0, 300)}` });
    }

    await SocialAccount.findOneAndUpdate(
      { platform: 'instagram' },
      { $set: {
        igUserId, accessToken: token, tokenExpiresAt,
        username: prof.username || '', followers: Number(prof.followers_count) || 0,
        mediaCount: Number(prof.media_count) || 0, profilePicUrl: prof.profile_picture_url || '',
        lastSyncError: '',
      } },
      { upsert: true },
    );
    // Respond as soon as the credentials validate — the first full sync (up
    // to ~25 media × an insight call each) runs in the background so the
    // Connect button can't sit behind a gateway timeout; the account card
    // shows lastSyncAt/lastSyncError when it lands, and Sync now re-runs it.
    syncInstagram().catch(() => {});
    res.json({ account: await readMasked() });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// DELETE /api/social/account — disconnect (credential removal is a real
// delete; the posts and their stats all stay).
const disconnectAccount = async (req, res) => {
  try {
    await SocialAccount.deleteOne({ platform: 'instagram' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/social/account/sync — the tab's Sync now button.
const syncAccountNow = async (req, res) => {
  try {
    const r = await syncInstagram();
    res.json({ ...r, account: await readMasked() });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

module.exports = {
  listPosts, createPost, patchPost, addStat,
  getAccount, connectAccount, disconnectAccount, syncAccountNow,
  // exported for tests
  cleanPostFields, applyStatusStamps, cleanStatSnapshot, MAX_SNAPSHOTS,
};
