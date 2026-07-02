// services/emailEnricher.js
//
// FREE email discovery by scraping a business's OWN website — no paid lookup
// service (owner: website-scrape only). Smarter than a bare "search for @":
//   1. Pull every mailto: link first — those are addresses the site OWNER chose
//      to publish, so they're the real, deliverable ones.
//   2. Then regex any name@domain in the page text as a fallback.
//   3. Aggressively drop junk: asset filenames (foo@2x.png), tracking/CDN noise
//      (sentry, wixpress, example.com), and placeholders.
//   4. Rank what's left: role inboxes (info@, contact@, sales@, hello@) win, and
//      an address on the site's own domain beats an off-domain one.
//   5. If the homepage yields nothing, follow ONE likely /contact link and retry.
//
// Only the network calls (fetch) touch the outside world; the extraction/ranking
// is pure and unit-tested.

const axios = require('axios');

const POLITE_UA = 'JointPrintingLeadFinder/1.0 (+https://jointprinting.com)';
const FETCH_TIMEOUT_MS = 12_000;
const MAX_BYTES = 1_500_000;

// A general email shape. Intentionally permissive; the junk filter below does the
// real quality gate.
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
const MAILTO_RE = /mailto:([^"'?>\s]+)/gi;

// Local-parts / domains that are never a real contact we'd cold-email.
const JUNK_DOMAINS = [
  'example.com', 'example.org', 'domain.com', 'email.com', 'yourdomain.com',
  'sentry.io', 'sentry-next.wixpress.com', 'wixpress.com', 'wix.com', 'squarespace.com',
  'godaddy.com', 'cloudflare.com', 'schema.org', 'w3.org', 'sentry.wixpress.com',
];
const ASSET_EXT_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf)$/i;
const JUNK_LOCAL_RE = /^(your|name|email|user|username|firstname|lastname|someone|test|no-?reply|noreply|donotreply|do-not-reply)$/i;
// Role inboxes, in preference order — a shop that publishes info@ wants to hear it.
const ROLE_PRIORITY = ['info', 'contact', 'sales', 'hello', 'orders', 'store', 'admin', 'hi', 'team', 'management', 'office'];

// Clean + validate ONE raw email candidate → normalized address or ''. Pure.
function sanitizeEmail(raw) {
  let s = String(raw || '').trim().toLowerCase();
  // strip a trailing mailto query (?subject=…) and surrounding punctuation
  s = s.split('?')[0].replace(/^[<("']+|[>)"'.,;]+$/g, '');
  if (!s || s.length > 254) return '';
  const m = s.match(/^([a-z0-9._%+\-]+)@([a-z0-9.\-]+\.[a-z]{2,})$/);
  if (!m) return '';
  const [, local, domain] = m;
  if (ASSET_EXT_RE.test(s)) return '';
  if (JUNK_DOMAINS.includes(domain)) return '';
  if (JUNK_LOCAL_RE.test(local)) return '';
  // Hex-blob local parts (e.g. tracking hashes) — not a human inbox.
  if (/^[0-9a-f]{16,}$/.test(local)) return '';
  return s;
}

// Extract every usable email from a page's HTML, mailto:-links first. Pure.
function extractEmails(html) {
  const text = String(html || '');
  const ordered = [];
  const seen = new Set();
  const add = (raw) => {
    const e = sanitizeEmail(raw);
    if (e && !seen.has(e)) { seen.add(e); ordered.push(e); }
  };
  let m;
  MAILTO_RE.lastIndex = 0;
  while ((m = MAILTO_RE.exec(text)) !== null) add(decodeURIComponent(m[1]));
  const bodyMatches = text.match(EMAIL_RE) || [];
  for (const raw of bodyMatches) add(raw);
  return ordered;
}

// Rank extracted emails and return the single best (''). Role inboxes first,
// then same-domain-as-site, then first seen. Pure.
function pickBestEmail(emails, siteHost = '') {
  const list = (emails || []).filter(Boolean);
  if (!list.length) return '';
  const host = String(siteHost || '').toLowerCase().replace(/^www\./, '');
  const score = (e) => {
    const [local, domain] = e.split('@');
    let s = 0;
    const roleIdx = ROLE_PRIORITY.indexOf(local);
    if (roleIdx >= 0) s += (ROLE_PRIORITY.length - roleIdx) * 10; // role match, higher = better
    if (host && domain === host) s += 5;                          // on the shop's own domain
    if (host && domain.endsWith(`.${host}`)) s += 3;
    return s;
  };
  return [...list].sort((a, b) => score(b) - score(a))[0];
}

function hostOf(url) {
  try { return new URL(url).host.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

async function _get(url) {
  return axios.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    maxContentLength: MAX_BYTES,
    validateStatus: () => true,
    responseType: 'text',
    headers: { 'User-Agent': POLITE_UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
}

// Find a same-site /contact-ish link on a page to try next. Pure-ish (parses
// the passed HTML). Returns an absolute URL or ''.
function findContactLink(html, baseUrl) {
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  const base = (() => { try { return new URL(baseUrl); } catch { return null; } })();
  if (!base) return '';
  while ((m = re.exec(String(html || ''))) !== null) {
    const href = m[1];
    if (/\b(contact|about|reach|connect)\b/i.test(href) && !href.startsWith('mailto:') && !href.startsWith('tel:')) {
      try {
        const abs = new URL(href, base);
        if (abs.host.replace(/^www\./, '') === base.host.replace(/^www\./, '')) return abs.toString();
      } catch { /* skip bad href */ }
    }
  }
  return '';
}

// Scrape a website for its best contact email (network). Homepage first, then
// ONE contact page if needed. Always resolves to a string ('' on any failure) —
// enrichment must never throw and abort a whole finder run.
async function enrichWebsite(url) {
  const start = String(url || '').trim();
  if (!start) return '';
  try {
    const host = hostOf(start);
    const home = await _get(start);
    if (typeof home.data === 'string' && home.data) {
      const best = pickBestEmail(extractEmails(home.data), host);
      if (best) return best;
      const contactUrl = findContactLink(home.data, home.request?.res?.responseUrl || start);
      if (contactUrl) {
        const contact = await _get(contactUrl);
        if (typeof contact.data === 'string' && contact.data) {
          const b2 = pickBestEmail(extractEmails(contact.data), host);
          if (b2) return b2;
        }
      }
    }
  } catch (_err) {
    // swallow — a dead/slow site just yields no email
  }
  return '';
}

module.exports = {
  enrichWebsite,
  // pure — unit-tested
  sanitizeEmail,
  extractEmails,
  pickBestEmail,
  findContactLink,
  hostOf,
};
