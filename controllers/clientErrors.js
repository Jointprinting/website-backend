// controllers/clientErrors.js
//
// Crashes that happened in someone's browser, reported back.
//
// The report endpoint is PUBLIC and unauthenticated, and it has to be: the crash
// being reported may have taken down the very app that would have carried a
// token. That makes it a write path anyone on the internet can reach, so
// everything here is built around bounding what a stranger can do with it —
// every field capped, the route reduced to a pattern, an upsert instead of an
// insert, and a hard ceiling on how many distinct problems can exist at once.

const crypto = require('crypto');
const ClientError = require('../models/ClientError');

const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
// A ceiling on DISTINCT fingerprints. Real applications have tens of live bugs,
// not thousands; anything past this is someone generating unique messages on
// purpose. Existing rows keep counting — only NEW ones are refused.
const MAX_DISTINCT = 500;

const SOURCES = new Set(['render', 'window', 'promise']);

// PURE — exported for tests.
//
// A token in a URL is the client's CREDENTIAL. /approve/<token> must never be
// written to an error log, so a path is reduced to its pattern before storage:
// any segment that looks like an id, a hash or a token becomes a placeholder.
function routePattern(pathname) {
  const p = String(pathname || '').split('?')[0].split('#')[0];
  if (!p.startsWith('/')) return '/';
  return p.split('/').map((seg) => {
    if (!seg) return seg;
    // ObjectId first — it is also 16+ hex, and "/order/:id" reads better than
    // "/order/:token" when triaging.
    if (/^[0-9a-f]{24}$/i.test(seg)) return ':id';
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ':token';
    if (/^\d+$/.test(seg)) return ':n';
    if (seg.length > 20) return ':token';
    return seg;
  }).join('/').slice(0, 120) || '/';
}

// PURE — exported for tests.
//
// The same bug from two different people must land on one row. Message plus the
// FIRST stack frame is the standard choice: the message alone merges unrelated
// "undefined is not a function"s, and the whole stack splits one bug across
// every minified build it has ever appeared in.
function fingerprintOf(message, stack) {
  const msg = String(message || '').trim().slice(0, MAX_MESSAGE);
  const frame = String(stack || '').split('\n').map((l) => l.trim()).filter(Boolean)
    .find((l) => l.startsWith('at ')) || '';
  // Strip the host and any cache-busting hash so the same frame in yesterday's
  // build and today's is the same fingerprint.
  const norm = frame.replace(/https?:\/\/[^/]+/g, '').replace(/\.[0-9a-f]{8}\.chunk/g, '.chunk');
  return crypto.createHash('sha1').update(`${msg} ${norm}`).digest('hex');
}

// PURE — exported for tests. Coarse browser family only. Enough to notice "every
// report is one old Safari"; not a device fingerprint of the owner's clients.
function browserFamily(ua) {
  const s = String(ua || '');
  if (/Edg\//.test(s)) return 'Edge';
  if (/OPR\//.test(s)) return 'Opera';
  if (/Firefox\//.test(s)) return 'Firefox';
  if (/Chrome\//.test(s)) return 'Chrome';
  if (/Safari\//.test(s)) return 'Safari';
  return 'Other';
}

// POST /api/client-errors — PUBLIC. Always answers 204, even when it drops the
// report: a browser that just crashed must not then have to handle an error
// from the error reporter.
async function report(req, res) {
  try {
    const b = req.body || {};
    const message = String(b.message || '').trim().slice(0, MAX_MESSAGE);
    if (!message) return res.status(204).end();

    const stack = String(b.stack || '').slice(0, MAX_STACK);
    const source = SOURCES.has(b.source) ? b.source : 'window';
    const route = routePattern(b.route);
    const fingerprint = fingerprintOf(message, stack);
    const browser = browserFamily(req.get('user-agent'));
    const now = new Date();

    // Upsert on the fingerprint: a repeat increments, it never inserts. The
    // ceiling applies to NEW problems only, so an ongoing incident keeps
    // counting even once the cap is reached.
    const existing = await ClientError.findOne({ fingerprint }).select('_id').lean();
    if (!existing) {
      const distinct = await ClientError.estimatedDocumentCount();
      if (distinct >= MAX_DISTINCT) return res.status(204).end();
    }

    await ClientError.updateOne(
      { fingerprint },
      {
        $setOnInsert: { fingerprint, firstSeen: now, message, stack, source, route },
        $set: { lastSeen: now, clientFacing: !!b.clientFacing },
        $inc: { count: 1 },
        $addToSet: { browsers: browser },
      },
      { upsert: true },
    );
    res.status(204).end();
  } catch {
    // Deliberately silent. Nothing about a failure here is the reporter's
    // problem, and a 500 in an error handler is how you get a report loop.
    res.status(204).end();
  }
}

// GET /api/client-errors — owner-only. Unresolved first, newest first.
async function listErrors(req, res) {
  try {
    const showResolved = String(req.query.resolved || '') === '1';
    const rows = await ClientError.find(showResolved ? {} : { resolved: false })
      .sort({ lastSeen: -1 }).limit(200).lean();
    const open = rows.filter((r) => !r.resolved);
    res.json({
      errors: rows,
      counts: {
        open: open.length,
        // What the owner needs to know first: is a CLIENT seeing this?
        clientFacing: open.filter((r) => r.clientFacing).length,
        occurrences: open.reduce((t, r) => t + (r.count || 0), 0),
      },
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// POST /api/client-errors/:id/resolve — owner-only. Reversible.
async function resolveError(req, res) {
  try {
    const resolved = req.body?.resolved !== false;
    const row = await ClientError.findByIdAndUpdate(
      req.params.id,
      { $set: { resolved, resolvedAt: resolved ? new Date() : null, note: String(req.body?.note || '').slice(0, 300) } },
      { new: true },
    );
    if (!row) return res.status(404).json({ message: 'No such report.' });
    res.json({ error: row });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

module.exports = {
  report, listErrors, resolveError,
  // PURE — exported for tests.
  routePattern, fingerprintOf, browserFamily, MAX_DISTINCT,
};
