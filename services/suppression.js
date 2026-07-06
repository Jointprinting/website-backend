// services/suppression.js
//
// Thin service over the global Suppression list (models/Suppression.js). One
// place to WRITE a suppression (on unsub / complaint / hard bounce) and to CHECK
// one — used by the enroll path (batch check, one query for a whole candidate
// list) and the sender (single check right before a send). Keeping it here means
// the model stays dumb and every caller shares the same normalization.

const Suppression = require('../models/Suppression');

const normEmail = (e) => String(e == null ? '' : e).trim().toLowerCase();
const domainOf = (e) => {
  const s = normEmail(e);
  const i = s.lastIndexOf('@');
  return i >= 0 ? s.slice(i + 1) : '';
};
const isEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normEmail(e));

// Add an address to the global suppression list (idempotent upsert). Safe to
// call with a blank/garbage address (no-op). Never throws — suppression is
// always best-effort so it can be dropped into any write path without a guard.
async function suppress(email, { reason = '', source = '' } = {}) {
  const e = normEmail(email);
  if (!isEmail(e)) return false;
  try {
    await Suppression.findOneAndUpdate(
      { email: e },
      { $setOnInsert: { email: e, domain: domainOf(e), reason, source } },
      { upsert: true, new: true },
    );
    return true;
  } catch (err) {
    // A racing duplicate upsert (E11000) just means it's already suppressed.
    if (err && err.code === 11000) return true;
    console.warn('[suppression] write failed:', err.message);
    return false;
  }
}

// Is this single address suppressed? Used at send time.
async function isSuppressed(email) {
  const e = normEmail(email);
  if (!e) return false;
  try {
    return !!(await Suppression.exists({ email: e }));
  } catch {
    return false; // never let a lookup failure block a send decision
  }
}

// Given a list of addresses, return the Set of the ones that ARE suppressed —
// one query for a whole enroll/candidate batch instead of N round-trips.
async function suppressedSet(emails = []) {
  const list = [...new Set((emails || []).map(normEmail).filter(Boolean))];
  if (!list.length) return new Set();
  try {
    const rows = await Suppression.find({ email: { $in: list } }).select('email').lean();
    return new Set(rows.map((r) => r.email));
  } catch {
    return new Set();
  }
}

// Remove every suppression written by a given SOURCE, returning the freed
// addresses. Used by recovery tooling to undo the inline SMTP heuristic's
// auto-suppressions (source 'smtp-bounce') WITHOUT touching the authoritative
// provider-webhook bounces ('bounce-webhook' / 'complaint-webhook') or opt-outs
// ('unsubscribe-link'). Never throws.
async function removeBySource(source) {
  if (!source) return [];
  try {
    const rows = await Suppression.find({ source }).select('email').lean();
    const emails = rows.map((r) => r.email).filter(Boolean);
    if (emails.length) await Suppression.deleteMany({ source });
    return emails;
  } catch (err) {
    console.warn('[suppression] removeBySource failed:', err.message);
    return [];
  }
}

module.exports = { suppress, isSuppressed, suppressedSet, removeBySource, normEmail, domainOf, isEmail };
