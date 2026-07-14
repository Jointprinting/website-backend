const mongoose = require('mongoose');

// One connected social account (today: the owner's Instagram Business/Creator
// account via the Meta Graph API). Holds the credentials the sync service
// uses to pull follower counts + per-post engagement into the Content tab.
// Admin-only surface — the token never leaves /api/social/account responses
// masked, and nothing here is public.
const SocialAccountSchema = new mongoose.Schema({
  platform: { type: String, enum: ['instagram'], default: 'instagram', unique: true },

  igUserId:  { type: String, default: '' },   // the IG *Business* user id (not the @handle)
  username:  { type: String, default: '' },
  // Which Meta surface the token speaks to. 'facebook' = classic Page-linked
  // token via graph.facebook.com; 'instagram' = "Instagram API with Instagram
  // login" token (IGAA…) via graph.instagram.com. Set at connect time from the
  // token itself; the sync picks its host off this.
  apiHost: { type: String, enum: ['facebook', 'instagram'], default: 'facebook' },
  // Long-lived Meta user access token (~60 days). The sync surfaces
  // tokenExpiresAt so the tab can warn before it lapses; refreshing is a
  // re-paste (or automatic when FACEBOOK_APP_ID/SECRET are configured and the
  // exchange endpoint succeeds).
  accessToken:    { type: String, default: '' },
  tokenExpiresAt: { type: Date, default: null },

  followers:  { type: Number, default: 0 },
  mediaCount: { type: Number, default: 0 },
  profilePicUrl: { type: String, default: '' },

  lastSyncAt:    { type: Date, default: null },
  lastSyncError: { type: String, default: '' },

  // One point per sync-day — the tab's follower growth curve. Capped in the
  // sync so the doc stays small (400 daily points ≈ 13 months).
  followerHistory: [{ at: Date, followers: Number, _id: false }],
}, { timestamps: true });

module.exports = mongoose.model('SocialAccount', SocialAccountSchema);
