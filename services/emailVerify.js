// services/emailVerify.js
//
// FREE, no-service email verification — the guard that keeps scraped addresses
// from bouncing and torching sender reputation. Two cheap gates, no paid API:
//   1. Syntax — a real address shape.
//   2. Deliverability — the domain actually accepts mail (has MX records, or an
//      A record as SMTP fallback). A domain with no mail server can't receive
//      anything, so we drop it before it ever costs us a bounce.
//
// We verify per-DOMAIN (deduped) and cache within a run, so a state with 200
// shops on a handful of providers (gmail, wixsite, godaddy…) is a few dozen DNS
// lookups, not 200. Network calls live in verifyDomainsMx; everything else is
// pure and unit-tested.

const dns = require('dns').promises;

const MX_TIMEOUT_MS = 5000;
// Process-lifetime cache: domain → boolean. DNS is stable enough that caching
// across runs is a pure win (and it's reset on every deploy anyway).
const _mxCache = new Map();

const EMAIL_RE = /^[a-z0-9._%+\-]+@([a-z0-9.\-]+\.[a-z]{2,})$/;

// Shape check (lowercased). Pure.
function isLikelyEmail(email) {
  return EMAIL_RE.test(String(email || '').trim().toLowerCase());
}

// The domain of an email ('' if unparseable). Pure.
function emailDomain(email) {
  const m = String(email || '').trim().toLowerCase().match(EMAIL_RE);
  return m ? m[1] : '';
}

async function _withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error('dns-timeout')), ms); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(t); }
}

// A DNS failure is only meaningful if it's DEFINITIVE (this domain has no mail).
// A timeout / SERVFAIL / temp-failure says nothing about the domain — caching
// `false` for those used to permanently blank a good lead's email the first time
// the resolver hiccuped. Transient → don't cache; a later run retries.
function isTransientDnsError(e) {
  const c = e && e.code;
  return c === 'ETIMEOUT' || c === 'ETIMEDOUT' || c === 'ESERVFAIL'
    || c === 'ECONNREFUSED' || c === 'ECONNRESET' || c === 'EAI_AGAIN'
    || (e && e.message === 'dns-timeout');
}

// Does a domain accept mail? MX record wins; fall back to an A/AAAA record
// (RFC 5321 implicit MX). Only DEFINITIVE results are cached — transient DNS
// failures return "not deliverable for now" without poisoning the cache.
async function domainAcceptsMail(domain) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return false;
  if (_mxCache.has(d)) return _mxCache.get(d);
  // MX first.
  try {
    const mx = await _withTimeout(dns.resolveMx(d), MX_TIMEOUT_MS);
    if (Array.isArray(mx) && mx.length > 0) { _mxCache.set(d, true); return true; }
    // Resolved but empty → no MX; fall through to the A-record fallback.
  } catch (e) {
    if (isTransientDnsError(e)) return false; // do NOT cache — retry next run
    // else definitive "no MX" → try the A-record fallback below.
  }
  // A/AAAA fallback (implicit MX).
  try {
    const a = await _withTimeout(dns.resolve(d), MX_TIMEOUT_MS);
    const ok = Array.isArray(a) && a.length > 0;
    _mxCache.set(d, ok);
    return ok;
  } catch (e2) {
    if (isTransientDnsError(e2)) return false;   // transient — do NOT cache
    _mxCache.set(d, false);                        // definitive: no mail server
    return false;
  }
}

// Throwaway inbox providers — a valid-MX domain that still can't be sold to.
// Static list (free, no runtime lookup); extend as new ones surface.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamailblock.com', '10minutemail.com',
  'tempmail.com', 'temp-mail.org', 'throwawaymail.com', 'yopmail.com', 'trashmail.com',
  'getnada.com', 'maildrop.cc', 'sharklasers.com', 'dispostable.com', 'fakeinbox.com',
  'mailnesia.com', 'mintemail.com', 'tempinbox.com', 'emailondeck.com', 'spamgourmet.com',
  'tempr.email', 'moakt.com', 'mohmal.com', 'burnermail.io', '33mail.com', 'mailsac.com',
  'mvrht.com', 'inboxbear.com', 'fakemail.net', 'tmail.ws', 'mailcatch.com',
]);
function isDisposableDomain(domain) {
  return DISPOSABLE_DOMAINS.has(String(domain || '').trim().toLowerCase());
}

// Verify a batch of DOMAINS → Map(domain → boolean), deduped + concurrency-
// bounded. The unit of work is the domain, not the email, so N addresses on M
// domains cost M lookups.
async function verifyDomainsMx(domains, { concurrency = 6 } = {}) {
  const uniq = [...new Set((domains || []).map((d) => String(d || '').trim().toLowerCase()).filter(Boolean))];
  const out = new Map();
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, uniq.length) }, async () => {
    while (i < uniq.length) {
      const d = uniq[i++];
      out.set(d, await domainAcceptsMail(d));
    }
  });
  await Promise.all(runners);
  return out;
}

// Given candidates (each with an `email`) and a domain→ok map, split into
// deliverable vs rejected. An email is deliverable iff it's syntactically valid
// AND its domain accepts mail. Pure + unit-tested.
function partitionDeliverable(candidates, mxMap) {
  const good = [];
  const bad = [];
  for (const c of candidates || []) {
    const email = String(c && c.email ? c.email : '').trim().toLowerCase();
    const domain = emailDomain(email);
    const ok = !!email && !!domain && isLikelyEmail(email)
      && mxMap.get(domain) === true && !isDisposableDomain(domain);
    (ok ? good : bad).push(c);
  }
  return { good, bad };
}

module.exports = {
  isLikelyEmail,
  emailDomain,
  verifyDomainsMx,
  partitionDeliverable,
  domainAcceptsMail,
  isTransientDnsError,
  isDisposableDomain,
  _mxCache,
};
