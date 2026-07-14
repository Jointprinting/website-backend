// services/instagramSync.js
//
// Pulls the owner's Instagram numbers into the Content tab via the official
// Meta Graph API — followers on the account card, views/likes/comments on
// each posted card. Zero scraping; everything rides the token the owner
// pasted in (models/SocialAccount).
//
// The intelligent part is the MATCH: a synced media item joins its planner
// card by URL — the permalink Instagram reports vs the postUrl the owner
// pasted (or that an earlier sync imported). Matched posts get a stat
// snapshot APPENDED (same append-only series the manual logger writes, so
// the sparkline doesn't care where a point came from); recent media with no
// card at all is auto-imported as a posted card, which is how "scan my
// current account" fills the tab on first connect.
//
// Runs every 12h from server.js + on-demand from the tab's Sync now button.
// A missing/invalid token makes every entry point a cheap no-op with the
// error surfaced on the account card — never a crash, never a retry storm.

const axios = require('axios');
const SocialAccount = require('../models/SocialAccount');
const SocialPost = require('../models/SocialPost');

const GRAPH = 'https://graph.facebook.com/v21.0';
// "Instagram API with Instagram login" host — used when the owner connected
// with an IGAA… token from an Instagram app (no Facebook Page involved).
const IG_GRAPH = 'https://graph.instagram.com';
const MEDIA_LIMIT = 25;            // most-recent media swept per sync
const HISTORY_CAP = 400;           // daily follower points kept (~13 months)
const RESNAP_AFTER_MS = 7 * 24 * 60 * 60 * 1000;   // unchanged numbers re-snapshot weekly
// Only auto-import media newer than this. Matches services/archivePurge.js
// ARCHIVE_TTL_DAYS on purpose: an auto-imported card the owner archives is
// purged 60+ days after it was posted, so by then its media is too old to
// re-import — no delete → re-import resurrection loop.
const IMPORT_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

// Join key for "is this media that planner card": Instagram permalinks and
// hand-pasted URLs differ by protocol case, query junk (igsh=…), and trailing
// slashes — strip all of it down to host+path.
function normalizePostUrl(u) {
  const s = String(u || '').trim().toLowerCase();
  if (!s) return '';
  const m = s.match(/^https?:\/\/(?:www\.)?([^?#]+)/);
  if (!m) return '';
  return m[1].replace(/\/+$/, '');
}

// Should this sync append a new stat snapshot? Yes when any number moved, or
// when the last point is a week stale (a flat line is still a data point —
// but not one per 12h run).
function shouldSnapshot(lastSnap, next, now = new Date()) {
  if (!lastSnap) return true;
  const moved = ['views', 'likes', 'comments'].some((k) => (Number(lastSnap[k]) || 0) !== (Number(next[k]) || 0));
  if (moved) return true;
  return (now - new Date(lastSnap.at || 0)) > RESNAP_AFTER_MS;
}

async function graphGet(path, params, base = GRAPH) {
  const { data } = await axios.get(`${base}/${path}`, { params, timeout: 20000 });
  return data;
}

// Which host this account's token speaks to.
function baseFor(acct) {
  return acct && acct.apiHost === 'instagram' ? IG_GRAPH : GRAPH;
}

// Instagram-login tokens (graph.instagram.com) are long-lived (~60 days) and
// self-refreshing: one GET bumps the clock another 60 days as long as the
// token is ≥24h old and unexpired. Called from the 12h sync when the stored
// expiry is unknown or inside 15 days — so a connected account never lapses
// while the sync is alive. Best-effort; a failure just leaves the old token.
async function refreshIgToken(acct) {
  if (!acct || acct.apiHost !== 'instagram' || !acct.accessToken) return false;
  const daysLeft = acct.tokenExpiresAt ? (new Date(acct.tokenExpiresAt) - Date.now()) / 86400000 : 0;
  if (daysLeft > 15) return false;
  try {
    const data = await graphGet('refresh_access_token', {
      grant_type: 'ig_refresh_token', access_token: acct.accessToken,
    }, IG_GRAPH);
    if (data && data.access_token) {
      acct.accessToken = data.access_token;
      acct.tokenExpiresAt = new Date(Date.now() + (Number(data.expires_in) || 60 * 86400) * 1000);
      await acct.save();
      return true;
    }
  } catch (e) { /* keep the current token — it may simply be <24h old */ }
  return false;
}

// Meta wraps its real message three levels deep — unwrap it once, here, for
// every caller (the connect flow reuses this instead of re-rolling it).
function graphErrorMessage(e) {
  return (e && e.response && e.response.data && e.response.data.error && e.response.data.error.message)
    || (e && e.message) || 'request failed';
}

// Best-effort per-media view count. Reels/videos report `views`; some photo
// media types don't — a missing metric is 0, never an error that kills the
// sync.
async function mediaViews(mediaId, accessToken, base = GRAPH) {
  try {
    const data = await graphGet(`${mediaId}/insights`, { metric: 'views', access_token: accessToken }, base);
    const row = (data.data || [])[0];
    const v = row && row.values && row.values[0] && row.values[0].value;
    return Number(v) || 0;
  } catch (e) {
    return 0;
  }
}

// The whole pull. Returns a summary the Sync-now button can toast.
async function syncInstagram() {
  const acct = await SocialAccount.findOne({ platform: 'instagram' });
  if (!acct || !acct.accessToken || !acct.igUserId) return { skipped: 'not-connected' };
  const now = new Date();
  const base = baseFor(acct);
  try {
    // Instagram-login tokens self-refresh — keep the 60-day clock wound.
    await refreshIgToken(acct).catch(() => {});

    // 1. Account card numbers + the daily follower-growth point. On the
    // Instagram host, /me is the professional account itself (no Page hop).
    const prof = await graphGet(base === IG_GRAPH ? 'me' : acct.igUserId, {
      fields: 'followers_count,media_count,username,profile_picture_url',
      access_token: acct.accessToken,
    }, base);
    acct.followers = Number(prof.followers_count) || 0;
    acct.mediaCount = Number(prof.media_count) || 0;
    acct.username = prof.username || acct.username;
    acct.profilePicUrl = prof.profile_picture_url || acct.profilePicUrl;
    const lastHist = acct.followerHistory[acct.followerHistory.length - 1];
    if (!lastHist || new Date(lastHist.at).toDateString() !== now.toDateString()) {
      acct.followerHistory.push({ at: now, followers: acct.followers });
      if (acct.followerHistory.length > HISTORY_CAP) {
        acct.followerHistory = acct.followerHistory.slice(-HISTORY_CAP);
      }
    }

    // 2. Recent media + their engagement.
    const media = await graphGet(base === IG_GRAPH ? 'me/media' : `${acct.igUserId}/media`, {
      fields: 'id,caption,permalink,timestamp,media_type,like_count,comments_count',
      limit: MEDIA_LIMIT,
      access_token: acct.accessToken,
    }, base);
    const items = media.data || [];

    // 3. Join against the planner by normalized URL. Only the LAST snapshot
    // matters for the moved-or-stale check, so slice the tail server-side
    // instead of deserializing up to 200 points per post per sync.
    const igPosts = await SocialPost.find(
      { platform: 'instagram' },
      { postUrl: 1, archived: 1, stats: { $slice: -1 } },
    ).lean();
    const byUrl = new Map(igPosts.map((p) => [normalizePostUrl(p.postUrl), p]).filter(([k]) => k));

    // Insight calls are independent — fetch them together instead of 25
    // sequential round-trips (this latency sits behind the Sync-now button).
    const viewsById = new Map(await Promise.all(
      items.map(async (m) => [m.id, await mediaViews(m.id, acct.accessToken, base)]),
    ));

    let updated = 0;
    let imported = 0;
    for (const m of items) {
      const key = normalizePostUrl(m.permalink);
      if (!key) continue;
      const existing = byUrl.get(key);
      const lastSnap = existing ? (existing.stats || [])[existing.stats.length - 1] : null;
      const snap = {
        at: now,
        views: viewsById.get(m.id) || 0,
        likes: Number(m.like_count) || 0,
        comments: Number(m.comments_count) || 0,
        // The Graph pull has no share metric — carry the owner's last manual
        // reading forward instead of stamping a fake drop to zero over it.
        shares: lastSnap ? (Number(lastSnap.shares) || 0) : 0,
      };
      if (existing) {
        if (shouldSnapshot(lastSnap, snap, now)) {
          await SocialPost.updateOne(
            { _id: existing._id },
            { $push: { stats: { $each: [snap], $slice: -200 } } },
          );
          updated += 1;
        }
      } else {
        // First sight of this media — give it a posted card so the tab shows
        // the WHOLE account's results, not just posts planned here. Age-gated
        // (IMPORT_MAX_AGE_MS) so a purged archived card can never resurrect.
        const postedAt = m.timestamp ? new Date(m.timestamp) : now;
        if (now - postedAt > IMPORT_MAX_AGE_MS) continue;
        const caption = String(m.caption || '');
        await SocialPost.create({
          platform: 'instagram',
          status: 'posted',
          title: caption.split('\n')[0].slice(0, 80) || 'Instagram post',
          body: caption.slice(0, 2200),
          postUrl: m.permalink || '',
          postedAt,
          stats: [snap],
        });
        imported += 1;
      }
    }

    acct.lastSyncAt = now;
    acct.lastSyncError = '';
    await acct.save();
    return { ok: true, followers: acct.followers, media: items.length, updated, imported };
  } catch (e) {
    const msg = graphErrorMessage(e);
    acct.lastSyncAt = now;
    acct.lastSyncError = String(msg).slice(0, 500);
    await acct.save().catch(() => {});
    return { error: acct.lastSyncError };
  }
}

// Every-12h scheduler (server.js). First run shortly after boot so a fresh
// deploy repaints the numbers without waiting half a day.
function startInstagramSync() {
  const run = () => syncInstagram()
    .then((r) => {
      if (r.ok) console.log(`[instagram] synced: ${r.followers} followers, ${r.updated} updated, ${r.imported} imported.`);
      else if (r.error) console.warn('[instagram] sync error:', r.error);
    })
    .catch((e) => console.warn('[instagram] sync crashed:', e.message));
  setTimeout(run, 12_000);
  setInterval(run, 12 * 60 * 60 * 1000);
}

module.exports = { syncInstagram, startInstagramSync, normalizePostUrl, shouldSnapshot, graphGet, graphErrorMessage, GRAPH, IG_GRAPH, baseFor, refreshIgToken };
