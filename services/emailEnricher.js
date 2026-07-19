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

// ── De-obfuscation (the biggest recall lever) ────────────────────────────────
// Small-business sites hide emails four common ways; a bare regex over raw HTML
// misses all of them. These are pure + unit-tested.

// Cloudflare "email protection": <span class="__cf_email__" data-cfemail="HEX">.
// The hex is the address XOR-encoded, first byte = the XOR key.
function decodeCfemail(hex) {
  const h = String(hex || '');
  if (h.length < 4 || h.length % 2 !== 0 || /[^0-9a-fA-F]/.test(h)) return '';
  try {
    const key = parseInt(h.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2), 16) ^ key);
    return out;
  } catch { return ''; }
}
function decodeCfEmails(html) {
  const out = [];
  const re = /data-cfemail=["']([0-9a-fA-F]+)["']/g;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const dec = decodeCfemail(m[1]);
    if (dec) out.push(dec);
  }
  return out;
}
// HTML entities that hide the @ and . (&#64; &commat; &#46; &period; + hex).
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => { try { return String.fromCharCode(parseInt(hex, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, dec) => { try { return String.fromCharCode(parseInt(dec, 10)); } catch { return _; } })
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.');
}
// "info [at] domain [dot] com" / "(at)" / "{dot}" → real @ and . . Bracketed
// forms are unambiguous; the bare " at … dot … tld" form is only rewritten when
// the whole email SHAPE is present, so normal prose ("meet at noon") is untouched.
function deobfuscate(html) {
  let t = decodeEntities(String(html || ''));
  t = t
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, '@')
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, '.')
    .replace(/([a-z0-9._%+\-]+)\s+at\s+([a-z0-9.\-]+)\s+dot\s+([a-z]{2,})\b/gi, '$1@$2.$3');
  return t;
}

// Extract every usable email from a page's HTML, mailto:-links first, then
// Cloudflare-protected, then a regex over both the raw and de-obfuscated text. Pure.
function extractEmails(html) {
  const raw = String(html || '');
  const ordered = [];
  const seen = new Set();
  const add = (candidate) => {
    const e = sanitizeEmail(candidate);
    if (e && !seen.has(e)) { seen.add(e); ordered.push(e); }
  };
  let m;
  MAILTO_RE.lastIndex = 0;
  while ((m = MAILTO_RE.exec(raw)) !== null) { try { add(decodeURIComponent(m[1])); } catch { add(m[1]); } }
  for (const e of decodeCfEmails(raw)) add(e);        // Cloudflare-protected
  for (const src of [raw, deobfuscate(raw)]) {         // raw + de-obfuscated body
    for (const candidate of (src.match(EMAIL_RE) || [])) add(candidate);
  }
  return ordered;
}

// Rank extracted emails and return the single best (''). Prefer a NAMED person on
// the shop's own domain — the best cold-outreach target, and what send-time
// pickEmail also prefers (they used to disagree: the enricher returned info@ and
// send-time then had no named address to choose). Then a role inbox on-domain,
// then off-domain. A lone role inbox is still returned, so a shop that only
// publishes info@ is never dropped. Pure.
function pickBestEmail(emails, siteHost = '') {
  const list = (emails || []).filter(Boolean);
  if (!list.length) return '';
  const host = String(siteHost || '').toLowerCase().replace(/^www\./, '');
  const score = (e) => {
    const [local, domain] = e.split('@');
    const onDomain = !!host && !!domain && (domain === host || domain.endsWith(`.${host}`));
    const roleIdx = ROLE_PRIORITY.indexOf(local);
    const isRole = roleIdx >= 0;
    let s = 0;
    if (onDomain) s += 100;                             // on the shop's own domain — strongly preferred
    if (!isRole) s += 40;                               // a named person beats a role inbox…
    else s += (ROLE_PRIORITY.length - roleIdx);         // …but a role inbox stays a ranked fallback
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

// Same-site links worth following, by path keyword → weight. Wholesale /
// partnerships pages are especially valuable for MERCH outreach (that's the buyer).
const LINK_KEYWORDS = [
  ['wholesale', 10], ['partnership', 9], ['contact-us', 9], ['contact', 8], ['get-in-touch', 8],
  ['our-team', 7], ['team', 6], ['staff', 6], ['leadership', 6], ['reach', 5], ['connect', 5],
  ['about-us', 5], ['about', 4], ['locations', 3], ['press', 3], ['careers', 2],
];

// Collect same-site candidate pages from a homepage, ranked by keyword weight,
// de-duped, best first. Pure. Returns up to `max` absolute URLs.
function rankContactLinks(html, baseUrl, max = 4) {
  const base = (() => { try { return new URL(baseUrl); } catch { return null; } })();
  if (!base) return [];
  const baseHost = base.host.replace(/^www\./, '');
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  const scored = new Map(); // absUrl -> weight (keep highest)
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    const href = m[1];
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) continue;
    let abs;
    try { abs = new URL(href, base); } catch { continue; }
    if (abs.host.replace(/^www\./, '') !== baseHost) continue;
    const path = (abs.pathname + abs.search).toLowerCase();
    let weight = 0;
    for (const [kw, w] of LINK_KEYWORDS) if (path.includes(kw)) { weight = Math.max(weight, w); }
    if (weight <= 0) continue;
    const key = abs.origin + abs.pathname;
    if (!scored.has(key) || scored.get(key) < weight) scored.set(key, weight);
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([u]) => u);
}

// Scrape a website for its best contact email (network). Homepage → a few
// keyword-ranked internal pages (contact / wholesale / team / about) → a couple
// of blind guesses, under a small page budget. Always resolves to a string
// ('' on any failure) — enrichment must never throw and abort a whole finder run.
async function enrichWebsite(url) {
  const start = String(url || '').trim();
  if (!start) return '';
  const host = hostOf(start);
  const seen = new Set();
  const tryPage = async (u) => {
    if (!u || seen.has(u)) return '';
    seen.add(u);
    try {
      const res = await _get(u);
      if (typeof res.data === 'string' && res.data) return { html: res.data, finalUrl: res.request?.res?.responseUrl || u };
    } catch { /* dead/slow page — skip */ }
    return null;
  };
  const PAGE_BUDGET = 5;
  try {
    const home = await tryPage(start);
    if (!home) return '';
    let best = pickBestEmail(extractEmails(home.html), host);
    if (best) return best;

    // Ranked internal pages from the homepage, then blind guesses if none.
    let targets = rankContactLinks(home.html, home.finalUrl, PAGE_BUDGET - 1);
    if (targets.length === 0) {
      const origin = (() => { try { return new URL(home.finalUrl).origin; } catch { return ''; } })();
      if (origin) targets = ['/contact', '/contact-us', '/about', '/wholesale'].map((p) => origin + p);
    }
    for (const t of targets) {
      if (seen.size >= PAGE_BUDGET) break;
      const page = await tryPage(t);
      if (!page) continue;
      best = pickBestEmail(extractEmails(page.html), host);
      if (best) return best;
    }
  } catch { /* swallow — a dead site just yields no email */ }
  return '';
}

module.exports = {
  enrichWebsite,
  // pure — unit-tested
  sanitizeEmail,
  extractEmails,
  pickBestEmail,
  findContactLink,
  rankContactLinks,
  decodeCfemail,
  decodeEntities,
  deobfuscate,
  hostOf,
};
