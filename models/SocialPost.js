const mongoose = require('mongoose');

// One piece of social content, from shower-thought to posted-with-numbers.
// The owner's idea vault is sacred: NOTHING here hard-deletes — retiring a
// post is archived:true (house rule, same as Orders/Transactions), so an idea
// can never "get deleted randomly".
//
// Status lifecycle (forward is the normal flow, but every move is allowed —
// pulling a scheduled post back to drafted is a real workflow):
//   idea       → a captured spark; may not even have a platform yet
//   drafted    → the text/visual is written and ready to schedule
//   scheduled  → has a target date (scheduledFor) on the weekly plan
//   posted     → live; postedAt stamps the week it counts toward the pace
//                goal, postUrl links the live post, stats snapshots accrue
// Instagram is THE platform — the owner dropped LinkedIn (never used it, and a
// pace goal that demanded LinkedIn posts made "week crushed" unreachable).
// PLATFORMS drives validation + the UI; the schema enum below still ACCEPTS
// 'linkedin' so the handful of legacy posts keep loading/archiving cleanly —
// they just can't be assigned to new work.
const PLATFORMS        = ['', 'instagram'];             // '' = unassigned idea
const LEGACY_PLATFORMS = ['', 'linkedin', 'instagram']; // schema-only: old docs stay valid
const POST_STATUSES = ['idea', 'drafted', 'scheduled', 'posted'];

// One engagement reading, taken whenever the owner pastes the numbers in
// (or, later, an API pull). Append-only: the series IS the growth curve.
const StatSnapshotSchema = new mongoose.Schema({
  at:       { type: Date, default: Date.now },
  views:    { type: Number, default: 0 },
  likes:    { type: Number, default: 0 },
  comments: { type: Number, default: 0 },
  shares:   { type: Number, default: 0 },
}, { _id: false });

const SocialPostSchema = new mongoose.Schema({
  platform: { type: String, enum: LEGACY_PLATFORMS, default: '' },
  status:   { type: String, enum: POST_STATUSES, default: 'idea', index: true },

  title: { type: String, default: '' },     // short vault handle ("dispo tour recap")
  body:  { type: String, default: '' },     // the post text / IG caption
  notes: { type: String, default: '' },     // hooks, visual direction, CTA ideas
  tags:  { type: [String], default: [] },

  // Visual planning for IG: a downscaled reference image (data URL, shrunk
  // client-side like the quoter's design uploads — never a full-res original).
  refImage: { type: String, default: '' },

  scheduledFor: { type: Date, default: null },  // the week-plan slot
  postedAt:     { type: Date, default: null },  // stamps the pace week
  postUrl:      { type: String, default: '' },  // the live post

  stats: { type: [StatSnapshotSchema], default: [] },

  // Soft-archive only — the vault never loses an idea.
  archived:   { type: Boolean, default: false, index: true },
  archivedAt: { type: Date, default: null },
}, { timestamps: true });

SocialPostSchema.index({ archived: 1, status: 1, updatedAt: -1 });

SocialPostSchema.statics.PLATFORMS = PLATFORMS;
SocialPostSchema.statics.POST_STATUSES = POST_STATUSES;

const SocialPost = mongoose.model('SocialPost', SocialPostSchema);
SocialPost.PLATFORMS = PLATFORMS;
SocialPost.POST_STATUSES = POST_STATUSES;

module.exports = SocialPost;
