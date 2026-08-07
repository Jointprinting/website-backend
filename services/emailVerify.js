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
    // null, NOT false: hygiene PERMANENTLY suppresses an address it is told has
    // no mail server, so a resolver timeout must never be able to say that. Not
    // cached either — retry next run.
    if (isTransientDnsError(e)) return null;
    // else definitive "no MX" → try the A-record fallback below.
  }
  // A/AAAA fallback (implicit MX).
  try {
    const a = await _withTimeout(dns.resolve(d), MX_TIMEOUT_MS);
    const ok = Array.isArray(a) && a.length > 0;
    _mxCache.set(d, ok);
    return ok;
  } catch (e2) {
    if (isTransientDnsError(e2)) return null;    // transient — do NOT cache, do NOT condemn
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
      // A domain we could not resolve is OMITTED rather than recorded false —
      // callers act on `=== false` and must not read "we could not tell" as
      // "this domain has no mail server".
      const verdict = await domainAcceptsMail(d);
      if (verdict !== null) out.set(d, verdict);
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


// ── Gate 3: does the MAILBOX exist? ──────────────────────────────────────────
//
// MX proves the DOMAIN takes mail. It says nothing about whether
// feedback@theirshop.com is a real mailbox — and that gap is where the hard
// bounces come from: addresses a shop really did publish, whose mailbox has
// since been deleted. The domain still answers; the person is gone.
//
// So we ask the receiving server directly, the way every list-cleaning service
// does: open the SMTP conversation, name the recipient, read the answer, and
// hang up BEFORE sending anything. The recipient never sees a message. A 550 at
// RCPT is the server telling us the mailbox doesn't exist.
//
// Three verdicts, and the default matters:
//   'dead'    — the server explicitly refused the recipient. Don't send.
//   'ok'      — accepted, and the domain is not a catch-all.
//   'unknown' — anything else: catch-all domain, timeout, greylist, blocked
//               port, 4xx. We SEND. This gate may only ever prevent a bounce,
//               never block a real lead on a guess.
//
// Catch-all check first: plenty of domains accept every recipient, so a bare
// 250 proves nothing there. We probe an address that cannot exist; if THAT is
// accepted, every verdict on that domain is 'unknown'.
//
// Port 25 outbound is blocked by many hosts. Rather than fail silently forever,
// the module notices it has never once connected and stops trying — and says so
// in the log, so "verification is on" can't quietly mean "verification is a
// no-op".

const net = require('net');

const SMTP_PORT = 25;
const SMTP_TIMEOUT_MS = 8000;
const PROBE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // a mailbox verdict keeps
const _probeCache = new Map();      // email → { verdict, at }
const _catchAllCache = new Map();   // domain → { catchAll, at }

// Port-25 reachability, learned at runtime.
let _connectAttempts = 0;
let _connectSuccesses = 0;
let _port25Blocked = false;
const BLOCKED_AFTER = 6;            // consecutive failures before we stop trying

function probeIdentity(env = process.env) {
  const from = String(env.OUTREACH_PROBE_FROM || env.SMTP_USER || 'postmaster@jointprinting.com').trim();
  const helo = String(env.OUTREACH_PROBE_HELO || (from.split('@')[1] || 'jointprinting.com')).trim();
  return { from, helo };
}

/** One SMTP conversation. Resolves { code, ok } for the RCPT, or null if we couldn't talk. */
function smtpRcptCheck(host, address, { env = process.env, timeoutMs = SMTP_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const { from, helo } = probeIdentity(env);
    const socket = net.createConnection({ host, port: SMTP_PORT });
    let stage = 'greet';
    let done = false;
    let buffer = '';

    const finish = (result) => {
      if (done) return;
      done = true;
      try { socket.end('QUIT\r\n'); } catch { /* already gone */ }
      try { socket.destroy(); } catch { /* already gone */ }
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(null));
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // Wait for a COMPLETE reply: the last line must be "NNN " (space, not '-').
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || '';
      if (!/^\d{3} /.test(last)) return;
      const code = parseInt(last.slice(0, 3), 10);
      buffer = '';

      if (stage === 'greet') {
        if (code !== 220) return finish(null);
        stage = 'helo';
        socket.write(`EHLO ${helo}\r\n`);
      } else if (stage === 'helo') {
        if (code >= 400) return finish(null);
        stage = 'mail';
        socket.write(`MAIL FROM:<${from}>\r\n`);
      } else if (stage === 'mail') {
        if (code >= 400) return finish(null);
        stage = 'rcpt';
        socket.write(`RCPT TO:<${address}>\r\n`);
      } else if (stage === 'rcpt') {
        finish({ code, ok: code >= 200 && code < 300 });
      }
    });
  });
}

/** The MX host to talk to for a domain, or '' when there isn't one. */
async function primaryMx(domain) {
  try {
    const rows = await dns.resolveMx(domain);
    if (rows && rows.length) {
      return rows.slice().sort((a, b) => a.priority - b.priority)[0].exchange;
    }
  } catch { /* fall through */ }
  try {
    const a = await dns.resolve4(domain);
    return a && a.length ? domain : '';
  } catch { return ''; }
}

/** Does this domain accept ANY recipient? Cached per domain. */
async function isCatchAll(domain, mx, opts = {}) {
  const hit = _catchAllCache.get(domain);
  if (hit && Date.now() - hit.at < PROBE_CACHE_TTL_MS) return hit.catchAll;
  // An address nobody would ever create. Stable per domain so a retry reuses it.
  const probe = `no-such-mailbox-jp-${domain.replace(/[^a-z0-9]/g, '').slice(0, 8)}@${domain}`;
  const res = await smtpRcptCheck(mx, probe, opts);
  if (!res) return null;                             // couldn't tell
  const catchAll = res.ok;
  _catchAllCache.set(domain, { catchAll, at: Date.now() });
  return catchAll;
}

/**
 * 'dead' | 'ok' | 'unknown' for one address. NEVER throws. Fails to 'unknown',
 * which means "send it" — this gate may only ever prevent a bounce, never block
 * a real lead on a guess.
 */
async function verifyMailbox(email, opts = {}) {
  const address = String(email || '').trim().toLowerCase();
  if (!isLikelyEmail(address)) return 'dead';        // not an address at all
  if (_port25Blocked) return 'unknown';

  const cached = _probeCache.get(address);
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) return cached.verdict;

  const domain = emailDomain(address);
  if (!domain) return 'dead';
  const mx = await primaryMx(domain);
  if (!mx) return 'dead';                            // no mail server at all

  _connectAttempts += 1;
  const catchAll = await isCatchAll(domain, mx, opts);
  if (catchAll === null) {
    // Never talked to it. Once that's happened enough times in a row with zero
    // successes anywhere, the host is blocking port 25 and this whole gate is a
    // no-op — say so out loud instead of pretending to verify.
    if (_connectSuccesses === 0 && _connectAttempts >= BLOCKED_AFTER) {
      _port25Blocked = true;
      console.warn('[verify] outbound port 25 looks blocked here — mailbox verification is OFF (every address will be treated as unknown and still sent). A paid verification API would be the alternative.');
    }
    return 'unknown';
  }
  _connectSuccesses += 1;
  if (catchAll) {                                     // accepts everything, tells us nothing
    _probeCache.set(address, { verdict: 'unknown', at: Date.now() });
    return 'unknown';
  }

  const res = await smtpRcptCheck(mx, address, opts);
  if (!res) return 'unknown';
  // 550/551/553 and 5.x.x at RCPT = "no such mailbox". 4xx is temporary.
  const verdict = res.ok ? 'ok' : (res.code >= 500 && res.code < 600 ? 'dead' : 'unknown');
  _probeCache.set(address, { verdict, at: Date.now() });
  return verdict;
}

/** Verify many, bounded concurrency. Returns Map(email → verdict). Never throws. */
async function verifyMailboxes(emails = [], { concurrency = 4, ...opts } = {}) {
  const list = [...new Set(emails.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))];
  const out = new Map();
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const email = list[i++];
      out.set(email, await verifyMailbox(email, opts).catch(() => 'unknown'));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return out;
}

/** Is this gate actually doing anything in this environment? For the Studio. */
const mailboxProbeStatus = () => ({
  blocked: _port25Blocked,
  attempts: _connectAttempts,
  successes: _connectSuccesses,
});

module.exports = {
  isLikelyEmail,
  verifyMailbox,
  verifyMailboxes,
  mailboxProbeStatus,
  smtpRcptCheck,
  emailDomain,
  verifyDomainsMx,
  partitionDeliverable,
  domainAcceptsMail,
  isTransientDnsError,
  isDisposableDomain,
  _mxCache,
};
