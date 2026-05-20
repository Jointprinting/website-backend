// services/jpwAuditor.js
//
// Website auditor for JPW lead recon. Fetches a lead's site, parses the HTML
// with cheerio, and produces the website_audit subdoc that the scoring
// engine consumes for the Pain Score.
//
// What we check (mirror of GPT spec):
//   - Reachability:    status code, final URL after redirects, SSL, load time
//   - Mobile readiness: viewport meta tag
//   - SEO basics:      <title>, <meta description>, <h1>, LocalBusiness schema
//   - Conversion:      visible phone, tel: click-to-call link, contact form,
//                      quote / "free estimate" CTA, gallery, reviews on page
//   - Local SEO:       service-area town mentions, embedded Google map,
//                      LocalBusiness schema present
//   - Trust / freshness: copyright year (current vs >1yr old)
//   - Marketing tells:  tracking pixels (gtag, fbpixel, GTM), landing-page
//                       structure (long-form, single CTA, no nav)
//   - CMS sniff:       WordPress / Wix / Squarespace / GoDaddy / Shopify
//
// Intentionally bandwidth-light: ONE HTTP request per audit, no follow-up
// requests for assets or sub-pages. PageSpeed Insights (separate Google API,
// requires a key) gets called only if PAGESPEED_KEY is set — otherwise the
// mobile_speed_score field is left null and Pain Score skips that bucket.

const axios = require('axios');
const cheerio = require('cheerio');

const FETCH_TIMEOUT_MS = 15000;
const MAX_CONTENT_BYTES = 1.5 * 1024 * 1024; // 1.5MB — anything bigger is junk
const PAGESPEED_TIMEOUT_MS = 25000; // PSI is slow, 20s tail latency is normal

// ── Helpers ───────────────────────────────────────────────────────────────
function normalizeUrlForFetch(raw = '') {
  let s = String(raw).trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}

const PHONE_REGEX = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/g;

const QUOTE_CTA_PHRASES = [
  /free\s+(estimate|quote|inspection|consultation)/i,
  /request\s+(a\s+)?(quote|estimate)/i,
  /get\s+(a\s+)?(quote|estimate|price)/i,
  /schedule\s+(an?\s+)?(estimate|appointment|service|consultation)/i,
  /book\s+(now|today|an?\s+appointment)/i,
  /call\s+(now|today|us)/i,
  /contact\s+us\s+(today|now)/i,
];

const REVIEW_KEYWORDS_ON_SITE = [
  /testimonial/i, /what (our|my) (customers|clients) say/i,
  /reviews?/i, /\b5[-\s]star\b/i, /★★★★/, /happy\s+customers?/i,
];

const GALLERY_KEYWORDS = [
  /before\s*(\/|and|&)\s*after/i,
  /gallery/i, /our work/i, /portfolio/i, /completed projects/i,
  /\bphotos?\b/i,
];

const MAP_EMBED_HOSTS = ['google.com/maps/embed', 'maps.google', 'google.com/maps'];

const TRACKING_PATTERNS = [
  /gtag\s*\(/, /googletagmanager\.com/, /google-analytics\.com/,
  /fbq\s*\(/, /connect\.facebook\.net\/.+\/fbevents/,
  /clarity\.ms/, /hotjar/, /linkedin\.com\/insight/,
];

const CMS_FINGERPRINTS = [
  { rx: /wp-content|wordpress|wp-includes/i,     cms: 'WordPress' },
  { rx: /squarespace/i,                          cms: 'Squarespace' },
  { rx: /wix\.com|wixstatic\.com/i,              cms: 'Wix' },
  { rx: /godaddy\.com\/sites|x\.godaddysites/i,  cms: 'GoDaddy Builder' },
  { rx: /shopify/i,                              cms: 'Shopify' },
  { rx: /webflow/i,                              cms: 'Webflow' },
  { rx: /weebly/i,                               cms: 'Weebly' },
  { rx: /duda(\.co|\.cdn)/i,                     cms: 'Duda' },
  { rx: /thryv/i,                                cms: 'Thryv' },
  { rx: /\/cdn-cgi\/scripts\/.+\/cloudflare-static/i, cms: 'Static + Cloudflare' },
];

// Try the URL as-given; if that fails, fall back to https variant of the
// host. Returns { response, error, finalUrl } — we never throw past this.
async function fetchOnce(url) {
// Two-pass fetch:
//  1. "Polite" identifying User-Agent. Most sites accept it; we'd rather be
//     honest about being a bot when nobody's blocking us.
//  2. If the polite pass returns 4xx (typically 403/409 from Cloudflare/Akamai
//     bot protection), retry with a realistic Chrome User-Agent. Less polite,
//     but a fair number of sites only block obviously-named bots and let
//     anything that looks like a browser through.
// If BOTH passes fail with non-2xx, we return ok:false with the second
// response's status. The caller treats that as "couldn't audit" and the UI
// shows a clean "site blocked" message instead of a misleading checklist.
const POLITE_UA   = 'Mozilla/5.0 (compatible; JPWebworksBot/1.0; +https://jointprinting.com)';
const REALISTIC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function _attemptFetch(url, userAgent) {
  const res = await axios.get(url, {
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    maxContentLength: MAX_CONTENT_BYTES,
    validateStatus: () => true,
    responseType: 'text',
    headers: {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  return res;
}

async function fetchOnce(url) {
  const start = Date.now();
  try {
    let res = await _attemptFetch(url, POLITE_UA);
    if (res.status >= 400 && res.status < 600) {
      // Polite UA got blocked. Retry as a regular Chrome browser.
      res = await _attemptFetch(url, REALISTIC_UA);
    }
    const isOk = res.status >= 200 && res.status < 400;
    return {
      ok: isOk,
      status: res.status,
      finalUrl: res.request?.res?.responseUrl || url,
      html: isOk && typeof res.data === 'string' ? res.data : '',
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      status: err.response?.status || 0,
      error: err.code || err.message || 'fetch failed',
      finalUrl: '',
      html: '',
      duration: Date.now() - start,
    };
  }
}

// ── Public: audit one URL ────────────────────────────────────────────────
//
// `cityHints` is an optional list of strings to look for as service-area
// terms (we pass the SJ town list so a roofer in Camden mentioning Voorhees
// gets credit for it).
// PageSpeed Insights — free Google API. Returns 0-100 perf scores for both
// strategies. Optional: only called when PAGESPEED_KEY is set. The auditor
// falls back to silent skip on any failure so PSI being slow or down never
// blocks an HTML audit from succeeding.
async function fetchPageSpeed(url, strategy = 'mobile') {
  const key = process.env.PAGESPEED_KEY;
  if (!key) return null;
  try {
    const { data } = await axios.get('https://www.googleapis.com/pagespeedonline/v5/runPagespeed', {
      params: { url, strategy, category: 'performance', key },
      timeout: PAGESPEED_TIMEOUT_MS,
    });
    const score = data?.lighthouseResult?.categories?.performance?.score;
    return typeof score === 'number' ? Math.round(score * 100) : null;
  } catch (err) {
    // PSI fails commonly on slow / blocked sites — just log and skip.
    console.warn(`[jpwAuditor] PageSpeed ${strategy} failed for ${url}: ${err.message}`);
    return null;
  }
}

async function auditUrl(rawUrl, { cityHints = [], usePageSpeed = true } = {}) {
  const audited_url = normalizeUrlForFetch(rawUrl);
  const audited_at = new Date();
  if (!audited_url) {
    return {
      audited_url: '',
      audited_at,
      loads_successfully: false,
      notes: 'No URL provided.',
    };
  }

  const fetched = await fetchOnce(audited_url);
  const out = {
    audited_url,
    audited_at,
    final_url: fetched.finalUrl,
    status_code: fetched.status,
    loads_successfully: fetched.ok && fetched.status >= 200 && fetched.status < 400,
    ssl_valid: (fetched.finalUrl || audited_url).startsWith('https://'),
    notes: fetched.ok ? '' : humanizeFetchError(fetched.error),
  };

  if (!fetched.html) {
    return out; // can't parse — return what we have
  }

  // ── Parse ──────────────────────────────────────────────────────────────
  const $ = cheerio.load(fetched.html);
  const headHtml = $('head').html() || '';
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const fullHtml = fetched.html;
  const lowerHtml = fullHtml.toLowerCase();

  out.has_mobile_viewport = !!$('meta[name="viewport"]').attr('content');
  out.title = ($('title').first().text() || '').trim();
  out.has_title = !!out.title;
  out.meta_description = ($('meta[name="description"]').attr('content') || '').trim();
  out.has_meta_description = !!out.meta_description;
  const h1 = $('h1').first().text().trim();
  out.h1 = h1;
  out.has_h1 = !!h1;

  // Phone presence + tel: link
  out.has_visible_phone = PHONE_REGEX.test(bodyText);
  // Reset regex lastIndex (global regex state leaks between calls otherwise)
  PHONE_REGEX.lastIndex = 0;
  out.has_click_to_call = $('a[href^="tel:"]').length > 0;

  // Contact form: any <form> that asks for email or message
  out.has_contact_form = $('form').toArray().some((f) => {
    const html = $.html(f).toLowerCase();
    return /input[^>]+type=["']?email/.test(html)
        || /name=["']email/.test(html)
        || /<textarea/.test(html)
        || /input[^>]+name=["']?(message|comments?|inquiry|details?)/i.test(html);
  });

  // Quote CTA — text-level scan of links + buttons + common CTA areas
  const ctaText = [
    ...$('a').map((_, el) => $(el).text()).get(),
    ...$('button').map((_, el) => $(el).text()).get(),
    ...$('[role="button"]').map((_, el) => $(el).text()).get(),
  ].join(' ');
  out.has_quote_cta = QUOTE_CTA_PHRASES.some((rx) => rx.test(ctaText) || rx.test(bodyText.slice(0, 2500)));

  // Services list — generic but useful heuristic: a section or nav with
  // multiple "Service" entries, OR an "Our Services" heading
  out.has_services_list = /our\s+services|services\s+we\s+offer|what\s+we\s+do/i.test(bodyText)
                       || $('nav a, header a, footer a').filter((_, el) =>
                            /services?/i.test($(el).text())).length > 0;

  // Service-area town mentions
  const cityMatches = (cityHints || []).filter((c) =>
    new RegExp(`\\b${escapeRegex(c)}\\b`, 'i').test(bodyText)
  );
  out.has_service_area_terms = cityMatches.length > 0 || /service\s+area/i.test(bodyText);
  out.service_area_count = cityMatches.length;

  // Reviews on site
  out.has_reviews_on_site = REVIEW_KEYWORDS_ON_SITE.some((rx) => rx.test(bodyText));

  // Gallery
  out.has_gallery = GALLERY_KEYWORDS.some((rx) => rx.test(bodyText))
                 || $('img').length >= 8;

  // Google map embed
  out.has_google_map_embed = $('iframe[src*="google.com/maps"], iframe[src*="maps.google"]').length > 0
                          || MAP_EMBED_HOSTS.some((h) => lowerHtml.includes(h));

  // Schema (JSON-LD)
  const ldNodes = $('script[type="application/ld+json"]');
  let hasSchema = ldNodes.length > 0;
  let hasLocalBusinessSchema = false;
  ldNodes.each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const it of items) {
        const t = it['@type'];
        const types = Array.isArray(t) ? t : [t];
        if (types.some((x) => typeof x === 'string'
            && /local\s*business|professionalservice|.*\bService$|.*Contractor$|.*Cleaning$|RoofingContractor|Plumber|HVACBusiness|Electrician|HomeAndConstructionBusiness/i.test(x))) {
          hasLocalBusinessSchema = true;
        }
      }
    } catch { /* ignore malformed JSON-LD — many sites have it */ }
  });
  out.has_schema = hasSchema;
  out.has_localbusiness_schema = hasLocalBusinessSchema;

  // Copyright year
  const copyrightMatch = bodyText.match(/©\s*(\d{4})|copyright\s*(?:©|\(c\))?\s*(\d{4})/i);
  if (copyrightMatch) {
    const year = parseInt(copyrightMatch[1] || copyrightMatch[2], 10);
    if (isFinite(year)) {
      out.copyright_year = year;
      out.outdated_copyright = year < new Date().getFullYear() - 1;
    }
  }

  // Tracking pixels = marketing tell
  out.has_tracking_pixels = TRACKING_PATTERNS.some((rx) => rx.test(fullHtml));

  // Landing-page structure: single page, long body text, no full nav.
  // Crude proxy — short nav (<=3 links) AND long content (>3kb text) AND
  // a clear CTA presence.
  const navLinks = $('nav a, header a').length;
  out.has_landing_page_structure = navLinks > 0 && navLinks <= 4
                                && bodyText.length > 3000
                                && out.has_quote_cta;

  // CMS sniff — first match wins
  for (const fp of CMS_FINGERPRINTS) {
    if (fp.rx.test(headHtml) || fp.rx.test(fullHtml)) {
      out.cms_detected = fp.cms;
      break;
    }
  }
  // Meta generator fallback
  if (!out.cms_detected) {
    const gen = $('meta[name="generator"]').attr('content');
    if (gen) out.cms_detected = gen.split(/\s+/)[0];
  }

  // CTA above the fold — proxy: a quote CTA appears in the first ~1500 chars
  // of the rendered body (after header). This is a best-effort signal; many
  // SPAs hide content behind JS we can't execute server-side.
  out.has_cta_above_fold = QUOTE_CTA_PHRASES.some((rx) => rx.test(bodyText.slice(0, 1500)))
                        || $('a[href^="tel:"]').slice(0, 3).length > 0;

  // Internal anchor count — we don't follow them, but a doc with zero
  // internal links is suspicious (parked / brochure-only)
  const internalLinks = $('a').filter((_, el) => {
    const href = $(el).attr('href') || '';
    return href.startsWith('/') || href.startsWith('#')
        || (href.includes(extractHost(out.final_url || audited_url)) && !href.startsWith('mailto:'));
  }).length;
  out.broken_link_count = 0; // Reserved — we don't probe individual links
  if (internalLinks === 0 && fetched.html.length > 200) {
    out.notes = (out.notes ? out.notes + '; ' : '') + 'No internal links found';
  }

  // PageSpeed Insights — runs both strategies in parallel when configured.
  // Caller can disable (e.g. batch audits skip PSI to stay under daily quota).
  if (usePageSpeed && process.env.PAGESPEED_KEY) {
    const [mobile, desktop] = await Promise.all([
      fetchPageSpeed(out.final_url || audited_url, 'mobile'),
      fetchPageSpeed(out.final_url || audited_url, 'desktop'),
    ]);
    if (mobile !== null)  out.mobile_speed_score  = mobile;
    if (desktop !== null) out.desktop_speed_score = desktop;
  }

  return out;
}

function extractHost(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Translate Node / OpenSSL error codes into something the user can act on.
// fetchOnce stores either `err.code` (e.g. 'ENOTFOUND') or `err.message`, so
// we match both. Anything we don't recognize falls through with "Fetch
// failed:" as a prefix so the raw signal is still visible.
function humanizeFetchError(raw = '') {
  const s = String(raw || '').toUpperCase();
  if (s.includes('ENOTFOUND'))       return "Domain doesn't resolve (likely typo or expired)";
  if (s.includes('ECONNREFUSED'))    return 'Server refused the connection';
  if (s.includes('ETIMEDOUT') || s.includes('ECONNABORTED'))
                                     return "Server didn't respond in 15 seconds";
  if (s.includes('CERT_HAS_EXPIRED'))                 return 'SSL certificate expired';
  if (s.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE'))  return 'SSL certificate not trusted';
  if (s.includes('SELF_SIGNED_CERT_IN_CHAIN'))        return 'Self-signed SSL certificate';
  if (s.includes('EHOSTUNREACH') || s.includes('ENETUNREACH'))
                                     return 'Host unreachable';
  if (s.includes('ECONNRESET'))      return 'Connection reset by the server';
  return `Fetch failed: ${raw}`;
}

// Audit one lead in place: mutates and returns the updated audit subdoc.
// The caller (controller) is responsible for re-running scoreLead and saving.
async function auditLead(lead, options = {}) {
  if (!lead.website_url) {
    return {
      audited_url: '',
      audited_at: new Date(),
      loads_successfully: false,
      notes: 'No website URL on lead.',
    };
  }
  // Single-lead audit triggered from the UI gets PSI by default.
  // Bulk audits override usePageSpeed=false for speed/quota reasons.
  const opts = { usePageSpeed: true, ...options };
  return auditUrl(lead.website_url, opts);
}

// Run audits in parallel with a concurrency limit. Avoids hammering remote
// hosts and avoids blowing up our outbound socket budget on Render.
// `usePageSpeed` defaults to false here — PSI adds 20s+ per call and would
// turn a batch of 50 into a 15-minute job. Single-lead audits run PSI by
// default; bulk runs only do HTML.
async function auditLeadsConcurrent(leads, {
  concurrency = 4, cityHints = [], usePageSpeed = false,
  skipIfAuditedWithinDays = 0,
  onProgress,
} = {}) {
  const skipCutoff = skipIfAuditedWithinDays > 0
    ? new Date(Date.now() - skipIfAuditedWithinDays * 86400000)
    : null;
  const results = [];
  let cursor = 0;
  let done = 0;
  async function worker() {
    while (cursor < leads.length) {
      const i = cursor++;
      const lead = leads[i];
      // Skip recently-audited leads when caller asks. We still emit a result
      // so progress counts line up; the result's `audit` is the prior one
      // so the caller has something to save back if it merges blindly.
      if (skipCutoff && lead.website_audit?.audited_at
          && new Date(lead.website_audit.audited_at) > skipCutoff) {
        results.push({ lead, audit: null, error: null, skipped: true });
        done += 1;
        if (onProgress) onProgress(done, leads.length);
        continue;
      }
      try {
        const audit = await auditLead(lead, { cityHints, usePageSpeed });
        results.push({ lead, audit, error: null });
      } catch (err) {
        results.push({ lead, audit: null, error: err.message });
      }
      done += 1;
      if (onProgress) onProgress(done, leads.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, leads.length) }, worker));
  return results;
}

module.exports = {
  auditUrl,
  auditLead,
  auditLeadsConcurrent,
};
