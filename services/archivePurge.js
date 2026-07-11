// services/archivePurge.js
//
// The 60-day archive purge — Nate's explicit exception to the house
// archive-not-delete rule, scoped STRICTLY to presentation artifacts:
//
//   • Lookbooks   (status 'archived')  — curated galleries; heavy inline images
//   • SocialPosts (archived: true)     — content-planner cards
//
// Money and operational records (Orders, Transactions, Clients, POs …) are
// NEVER touched by this — their archives are business history and live
// forever. The clock is archivedAt ONLY: docs archived before the stamp
// existed get archivedAt backfilled to "now" on the first boot (below), so
// every legacy archive gets a full fresh 60-day window with the countdown
// visible in the UI — nothing is ever deleted before the owner has had the
// whole grace period to see it coming. Runs daily; the exception is also
// recorded in docs/ECOSYSTEM.md.

const Lookbook = require('../models/Lookbook');
const SocialPost = require('../models/SocialPost');
const Newsletter = require('../models/Newsletter');

const ARCHIVE_TTL_DAYS = 60;   // mirrored in frontend _shared.js ARCHIVE_TTL_DAYS

// Give every already-archived doc that predates the archivedAt stamp a clock
// starting NOW — the safety valve that makes the purge below strictly opt-in
// per-document from this deploy forward. Idempotent (only fills nulls).
async function backfillArchiveStamps(now = new Date()) {
  const lb = await Lookbook.updateMany(
    { status: 'archived', archivedAt: null },
    { $set: { archivedAt: now } },
  );
  const sp = await SocialPost.updateMany(
    { archived: true, archivedAt: null },
    { $set: { archivedAt: now } },
  );
  const nl = await Newsletter.updateMany(
    { archived: true, archivedAt: null },
    { $set: { archivedAt: now } },
  );
  return { lookbooks: lb.modifiedCount || 0, posts: sp.modifiedCount || 0, newsletters: nl.modifiedCount || 0 };
}

async function purgeExpiredArchives(now = new Date()) {
  const cutoff = new Date(now.getTime() - ARCHIVE_TTL_DAYS * 24 * 60 * 60 * 1000);
  // archivedAt only — a null stamp NEVER qualifies (backfill fills it first,
  // and Mongo's $lt is type-bracketed so null can't sneak past anyway).
  const lb = await Lookbook.deleteMany({ status: 'archived', archivedAt: { $lt: cutoff } });
  const sp = await SocialPost.deleteMany({ archived: true, archivedAt: { $lt: cutoff } });
  const nl = await Newsletter.deleteMany({ archived: true, archivedAt: { $lt: cutoff } });
  return { lookbooks: lb.deletedCount || 0, posts: sp.deletedCount || 0, newsletters: nl.deletedCount || 0 };
}

// Daily schedule, service-owned like its siblings (startInstagramSync,
// startGoogleDriveBackup): backfill stamps first, then purge; repeat every 24h.
function startArchivePurge() {
  const run = async () => {
    try {
      const b = await backfillArchiveStamps();
      if (b.lookbooks || b.posts || b.newsletters) console.log(`[archive] stamped ${b.lookbooks} lookbook(s), ${b.posts} post(s), ${b.newsletters} newsletter(s) archived pre-TTL — their 60-day clock starts now.`);
      const r = await purgeExpiredArchives();
      if (r.lookbooks || r.posts || r.newsletters) console.log(`[archive] purged ${r.lookbooks} lookbook(s), ${r.posts} content post(s), ${r.newsletters} newsletter(s) archived >${ARCHIVE_TTL_DAYS}d.`);
    } catch (e) {
      console.warn('[archive] purge failed (will retry tomorrow):', e.message);
    }
  };
  setTimeout(run, 8_000);
  setInterval(run, 24 * 60 * 60 * 1000);
}

module.exports = { purgeExpiredArchives, backfillArchiveStamps, startArchivePurge, ARCHIVE_TTL_DAYS };
