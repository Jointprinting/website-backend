// utils/migrationClaim.js
//
// RUN THIS EXACTLY ONCE, ACROSS EVERY INSTANCE.
//
// The boot migrations were check-then-act:
//
//     if (await migrations.findOne({ _id: KEY })) return;
//     await doTheWork();
//     await migrations.insertOne({ _id: KEY, ... });
//
// That is a race with a real victim. A deploy starts the NEW instance while the
// OLD one is still serving, so for a few seconds two processes boot together.
// Both reach the findOne before either has inserted, both see nothing, and both
// run the work. For the NDR resweep that means suppressing the same dead
// addresses twice; the confirmation backfill's own comment says it "must never
// re-run and stamp a NEW unpublished draft".
//
// It also has no failure story. The marker is written AFTER the work, so a
// migration that dies halfway leaves no trace and starts over from the beginning
// on the next boot — on top of whatever it already changed.
//
// The fix is to claim the work before doing it, atomically. The `_id` unique
// index that already exists on every Mongo collection IS the lock: one
// findOneAndUpdate with upsert either wins the claim or raises a duplicate-key
// error, and there is no window between the two. States are running → done, or
// running → failed, so a crashed migration is visibly stuck rather than silently
// gone, and can be retried deliberately.

// A claim held this long without finishing is presumed dead (the process was
// killed mid-migration) and may be taken over. Generous: a long backfill on a
// cold M0 is slow, and taking over a migration that is genuinely still running
// re-creates the exact double-run this module exists to prevent.
const STALE_AFTER_MS = 30 * 60 * 1000;

// Try to become the one instance that runs `key`.
//
// Returns true only if this caller now owns it. Returns false when the work is
// already done, is currently running somewhere else, or was claimed a moment ago
// by a racing boot — all three mean "not yours, don't run it".
async function claim(collection, key, { now = new Date(), staleAfterMs = STALE_AFTER_MS } = {}) {
  const staleBefore = new Date(now.getTime() - staleAfterMs);
  try {
    await collection.findOneAndUpdate(
      {
        _id: key,
        // Only a FAILED marker, or one whose owner has plainly died, is takeable.
        // A `done` marker matches nothing here — and neither does a legacy marker
        // written before this module existed (no `state` field), which is right:
        // those recorded completed work.
        $or: [
          { state: 'failed' },
          { state: 'running', startedAt: { $lt: staleBefore } },
        ],
      },
      { $set: { state: 'running', startedAt: now }, $inc: { attempts: 1 } },
      { upsert: true },
    );
    return true;
  } catch (e) {
    // The filter matched nothing and the upsert tried to INSERT a second doc with
    // this _id. That is precisely "a marker already exists and isn't takeable" —
    // the answer, not an error.
    if (e && (e.code === 11000 || e.code === 11001)) return false;
    throw e;
  }
}

// The work finished. Record what it did, so the ledger can answer "what has this
// database had done to it" without reading the code.
async function finish(collection, key, result = {}, { now = new Date() } = {}) {
  await collection.updateOne(
    { _id: key },
    { $set: { state: 'done', finishedAt: now, result }, $unset: { error: '' } },
  );
}

// The work threw. Leave the marker takeable so the next boot retries it, but
// leave the reason behind so a migration failing every boot is visible instead of
// being a warning line in a rolling log buffer nobody reads.
async function fail(collection, key, err, { now = new Date() } = {}) {
  await collection.updateOne(
    { _id: key },
    { $set: { state: 'failed', failedAt: now, error: String((err && err.message) || err || 'unknown') } },
  );
}

// Claim → run → record, with the failure path wired. `fn` runs only if this
// instance won the claim; its return value is stored as the result. Never throws:
// a migration is best-effort at boot and must not take the API down with it.
async function runOnce(collection, key, fn, opts = {}) {
  let owned = false;
  try {
    owned = await claim(collection, key, opts);
    if (!owned) return { ran: false, reason: 'claimed-elsewhere' };
    const result = await fn();
    await finish(collection, key, result && typeof result === 'object' ? result : { value: result }, opts);
    return { ran: true, result };
  } catch (e) {
    if (owned) await fail(collection, key, e, opts).catch(() => {});
    return { ran: false, reason: 'failed', error: String((e && e.message) || e) };
  }
}

module.exports = { claim, finish, fail, runOnce, STALE_AFTER_MS };
