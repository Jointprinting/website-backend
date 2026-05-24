// services/jpwAuditor.js
//
// Website auditor v2 for JPW lead recon.
//
// Pipeline per audit (one lead URL in):
//   1. Fetch the homepage with two-pass UA (polite, then realistic Chrome).
//   2. Pull the discovered nav links and, if they look like /contact, /services,
//      /about — fetch up to 2 of them in parallel. This catches phones and CTAs
//      that aren't on the homepage.
//   3. Run cheap HEAD probes in parallel for /favicon.ico, /robots.txt, and
//      /sitemap.xml. Peek the sitemap body (capped at 256 KB) to count URLs and
//      extract town-page URL patterns the body-text scan would miss.
//   4. Parse HTML with cheerio. Extract signals:
//        a. Reachability + SSL + TTFB
//        b. Viewport validation (content, not just presence)
//        c. JSON-LD with field validation (LocalBusiness must have name + tel + addr)
//        d. CTAs: text scan + tel: hrefs + form button labels
//        e. Form quality: count, action target, HTTPS-safe POST
//        f. Tech-stack fingerprints (jQuery + version, Bootstrap, React, Next,
//           Tailwind, Vue, Angular, etc.)
//        g. Default-template detection (Wix/Squarespace/GoDaddy default themes)
//        h. Conversion tools (chat widgets, appointment bookers)
//        i. Social links
//        j. Trust signals (favicon, OG, Twitter card)
//        k. Mixed content (HTTP refs on HTTPS page)
//        l. Phone extraction from text + tel: + schema, cross-checked vs lead phone
//   5. (Optional) PageSpeed Insights if PAGESPEED_KEY is set and the caller
//      asked for it. Single-lead audits enable it by default; batch audits skip.
//
// Output: a JSON object compatible with the WebsiteAuditSchema. All new fields
// are additive — the legacy fields the scorer reads (`has_click_to_call`,
// `has_quote_cta`, etc.) are still populated identically, just with more
// confidence now that we look at internal pages too.
//
// Performance: typical run is one homepage GET + 0-2 internal GETs + 3 HEADs.
// On a fast site it completes in ~1-2s. On a slow site, we hit the 15s
// per-request timeout per page and bail gracefully.

const axios = require('axios');
const cheerio = require('cheerio');

const FETCH_TIMEOUT_MS = 15000;
const HEAD_TIMEOUT_MS  = 6000;
const MAX_CONTENT_BYTES = 1.5 * 1024 * 1024;   // 1.5MB — bigger is junk for our purposes
const MAX_SITEMAP_BYTES = 256 * 1024;          // peek-only, sitemap can be huge
const PAGESPEED_TIMEOUT_MS = 25000;
const MAX_INTERNAL_PAGES = 2;                  // up to /contact + /services

// ── URL helpers ──────────────────────────────────────────────────────────
function normalizeUrlForFetch(raw = '') {
  let s = String(raw).trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return s;
}
function extractHost(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}
function originOf(u) {
  try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return ''; }
}
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function safeJoinUrl(base, href) {
  try { return new URL(href, base).toString(); } catch { return ''; }
}
function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  if (d.length === 10) return d;
  return '';
}

// ── Static patterns ──────────────────────────────────────────────────────
const PHONE_REGEX = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/g;

const QUOTE_CTA_PHRASES = [
  /free\s+(estimate|quote|inspection|consultation)/i,
  /request\s+(a\s+)?(quote|estimate)/i,
  /get\s+(a\s+)?(quote|estimate|price)/i,
  /schedule\s+(an?\s+)?(estimate|appointment|service|consultation|call)/i,
  /book\s+(now|today|an?\s+appointment|online)/i,
  /call\s+(now|today|us)/i,
  /contact\s+us\s+(today|now)/i,
  /start\s+(my|your)\s+(project|quote)/i,
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

// Tech-stack fingerprints. Order matters loosely — more-specific frameworks
// (Next.js) check before more-generic libraries (React) so we report the
// most actionable label.
const TECH_FINGERPRINTS = [
  { rx: /_next\/static|__NEXT_DATA__/,          label: 'Next.js' },
  { rx: /\/nuxt\/|__NUXT__/,                    label: 'Nuxt' },
  { rx: /sveltekit|__sveltekit/,                label: 'SvelteKit' },
  { rx: /react(?:-dom)?\.production\.min\.js|data-reactroot|react\.development\.js/, label: 'React' },
  { rx: /vue\.runtime\.min\.js|vue\.js@|__vue_app__/, label: 'Vue' },
  { rx: /\bng-app\b|angular(?:\.min)?\.js|@angular\//, label: 'Angular' },
  { rx: /jquery(-\d|\.min)/,                    label: 'jQuery' },
  { rx: /bootstrap(\.min)?\.(?:js|css)|class=["'][^"']*\bcol-(?:xs|sm|md|lg)-\d/i, label: 'Bootstrap' },
  { rx: /tailwind(?:css)?[-.]/,                 label: 'Tailwind' },
  { rx: /alpinejs|x-data=/,                     label: 'Alpine.js' },
  { rx: /htmx(?:\.min)?\.js|hx-get=/,           label: 'HTMX' },
  { rx: /elementor(?:-frontend)?/,              label: 'Elementor' },
  { rx: /divi-(?:builder|theme)/,               label: 'Divi' },
  { rx: /\bwoocommerce\b/,                      label: 'WooCommerce' },
  { rx: /font-?awesome/,                        label: 'Font Awesome' },
];

// Chat widget / appointment-tool fingerprints. These signal that the owner
// has actively invested in conversion tooling — a strong "they care" signal.
const CHAT_FINGERPRINTS = [
  { rx: /tawk\.to|embed\.tawk\.to/i,          name: 'Tawk.to' },
  { rx: /widget\.intercom\.io|intercom-frame/i, name: 'Intercom' },
  { rx: /js\.driftt\.com|drift\.com\/widget/i, name: 'Drift' },
  { rx: /olark\.com\/static/i,                name: 'Olark' },
  { rx: /tidio(?:chat)?\.(?:co|com)/i,        name: 'Tidio' },
  { rx: /\bcrisp\.chat\b|client\.crisp\.chat/i, name: 'Crisp' },
  { rx: /livechatinc|cdn\.livechatinc/i,      name: 'LiveChat' },
  { rx: /helpcrunch\.com\/widget/i,           name: 'HelpCrunch' },
  { rx: /podium\.com\/widget|podium-website-widget/i, name: 'Podium' },
  { rx: /\bbirdeye\.com\b|cdn\.birdeye/i,     name: 'Birdeye' },
  { rx: /smith\.ai/i,                         name: 'Smith.ai' },
];

const APPOINTMENT_FINGERPRINTS = [
  { rx: /calendly\.com/i,                     name: 'Calendly' },
  { rx: /acuityscheduling\.com|squarespace-scheduling/i, name: 'Acuity' },
  { rx: /housecallpro\.com\/online-booking/i, name: 'Housecall Pro' },
  { rx: /jobber\.com\/online-booking|getjobber/i, name: 'Jobber' },
  { rx: /servicetitan\.com/i,                 name: 'ServiceTitan' },
  { rx: /book(?:ing)?\.setmore\.com/i,        name: 'Setmore' },
  { rx: /squareup\.com\/appointments/i,       name: 'Square Appointments' },
];

const SOCIAL_HOSTS = [
  ['facebook',  /(?:^|\.)(?:facebook|fb)\.com\//i],
  ['instagram', /(?:^|\.)instagram\.com\//i],
  ['youtube',   /(?:^|\.)youtube\.com\/|youtu\.be\//i],
  ['linkedin',  /(?:^|\.)linkedin\.com\//i],
  ['tiktok',    /(?:^|\.)tiktok\.com\//i],
  ['x',         /(?:^|\.)twitter\.com\/|(?:^|\.)x\.com\//i],
  ['yelp',      /(?:^|\.)yelp\.com\/biz/i],
  ['nextdoor',  /(?:^|\.)nextdoor\.com\//i],
];

// Squarespace/Wix/GoDaddy "default template" tells. These sites are nearly
// always low-touch flips: the owner clicked through a template and never
// customized. Great pitch material.
const DEFAULT_TEMPLATE_TELLS = [
  { rx: /\bsqs-block\b|squarespace\.com\/templates/i,         tell: 'Squarespace default theme' },
  { rx: /wix\.com\/website-template|x-wix-app-instance/i,    tell: 'Wix template' },
  { rx: /godaddy\.com\/help\/website-builder/i,              tell: 'GoDaddy Website Builder' },
  { rx: /\bdivi-default\b|et_pb_section_0/i,                  tell: 'Divi default layout' },
];

// ── HTTP ─────────────────────────────────────────────────────────────────
const POLITE_UA   = 'Mozilla/5.0 (compatible; JPWebworksBot/1.0; +https://jointprinting.com)';
const REALISTIC_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

async function _httpGet(url, { userAgent, timeout = FETCH_TIMEOUT_MS, maxBytes = MAX_CONTENT_BYTES, responseType = 'text' } = {}) {
  return axios.get(url, {
    timeout,
    maxRedirects: 5,
    maxContentLength: maxBytes,
    validateStatus: () => true,
    responseType,
    headers: {
      'User-Agent': userAgent || POLITE_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
}

async function _httpHead(url) {
  // Some servers 405 a HEAD but happily 200 a GET — fall back to a tiny GET.
  try {
    const res = await axios.head(url, {
      timeout: HEAD_TIMEOUT_MS,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { 'User-Agent': POLITE_UA },
    });
    if (res.status >= 200 && res.status < 400) return { ok: true, status: res.status };
    if (res.status === 405) {
      const r2 = await _httpGet(url, { timeout: HEAD_TIMEOUT_MS, maxBytes: 8 * 1024 });
      return { ok: r2.status >= 200 && r2.status < 400, status: r2.status };
    }
    return { ok: false, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.code || err.message };
  }
}

async function fetchPage(url) {
  const start = Date.now();
  try {
    let res = await _httpGet(url, { userAgent: POLITE_UA });
    if (res.status >= 400 && res.status < 600) {
      res = await _httpGet(url, { userAgent: REALISTIC_UA });
    }
    const isOk = res.status >= 200 && res.status < 400;
    return {
      ok: isOk,
      status: res.status,
      finalUrl: res.request?.res?.responseUrl || url,
      html: isOk && typeof res.data === 'string' ? res.data : '',
      bytes: typeof res.data === 'string' ? res.data.length : 0,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      ok: false,
      status: err.response?.status || 0,
      error: err.code || err.message || 'fetch failed',
      finalUrl: '',
      html: '',
      bytes: 0,
      duration: Date.now() - start,
    };
  }
}

// PageSpeed Insights — same as before, optional, single-call helper.
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
    console.warn(`[jpwAuditor] PageSpeed ${strategy} failed for ${url}: ${err.message}`);
    return null;
  }
}

// ── Internal-page discovery ──────────────────────────────────────────────
//
// From the homepage's anchor tags, find up to MAX_INTERNAL_PAGES candidate
// links to /contact, /services, /about. We only fetch links on the same host
// to avoid being a crawler.
function discoverInternalPages($, baseUrl, finalUrl) {
  const baseHost = extractHost(finalUrl || baseUrl);
  if (!baseHost) return [];
  const candidates = new Map(); // url -> priority
  const score = (href, text) => {
    const t = (text || '').trim().toLowerCase();
    const h = (href || '').toLowerCase();
    if (/\bcontact\b/.test(h) || /\bcontact\b/.test(t)) return 3;
    if (/\bservice/.test(h)   || /\bservice/.test(t))   return 2;
    if (/\babout\b/.test(h)   || /\babout\b/.test(t))   return 1;
    return 0;
  };
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    const abs = safeJoinUrl(finalUrl || baseUrl, href);
    if (!abs) return;
    if (extractHost(abs) !== baseHost) return;
    if (abs === (finalUrl || baseUrl)) return;
    const pri = score(href, $(el).text());
    if (pri === 0) return;
    const prev = candidates.get(abs) || 0;
    if (pri > prev) candidates.set(abs, pri);
  });
  // Highest priority first, capped at MAX_INTERNAL_PAGES.
  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_INTERNAL_PAGES)
    .map(([url]) => url);
}

// ── Sitemap parsing — count <loc> entries, extract town-page URL slugs ──
function parseSitemapBody(xml, cityHints = []) {
  if (!xml) return { count: 0, townMatches: [] };
  // Cheap line-scan instead of a real XML parser — we only need <loc>
  // contents and a count.
  const locs = xml.match(/<loc[^>]*>([^<]+)<\/loc>/gi) || [];
  const urls = locs.map((l) => l.replace(/<\/?loc[^>]*>/gi, '').trim());
  const townSet = new Set();
  for (const url of urls) {
    for (const c of cityHints) {
      if (new RegExp(`[-/_]${escapeRegex(c.toLowerCase().replace(/\s+/g, '[-_]?'))}(?:[-/_.]|$)`, 'i').test(url.toLowerCase())) {
        townSet.add(c);
      }
    }
  }
  return { count: urls.length, townMatches: [...townSet] };
}

// ── JSON-LD extraction ──────────────────────────────────────────────────
function flattenJsonLd($) {
  const items = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const it of arr) {
        if (!it) continue;
        if (it['@graph'] && Array.isArray(it['@graph'])) items.push(...it['@graph']);
        else items.push(it);
      }
    } catch { /* ignore malformed JSON-LD */ }
  });
  return items;
}

const LOCAL_BUSINESS_TYPES = /local\s*business|professionalservice|.*\bService$|.*Contractor$|.*Cleaning$|RoofingContractor|Plumber|HVACBusiness|Electrician|HomeAndConstructionBusiness|GeneralContractor|MovingCompany/i;

function extractLocalBusinessSchema(items) {
  for (const it of items) {
    const t = it['@type'];
    const types = Array.isArray(t) ? t : [t];
    if (!types.some((x) => typeof x === 'string' && LOCAL_BUSINESS_TYPES.test(x))) continue;
    const addr = it.address;
    const addrParts = (addr && typeof addr === 'object')
      ? [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean).join(', ')
      : (typeof addr === 'string' ? addr : '');
    return {
      name: it.name || '',
      telephone: typeof it.telephone === 'string' ? it.telephone : '',
      address: addrParts,
      url: it.url || '',
      sameAs: Array.isArray(it.sameAs) ? it.sameAs : [],
    };
  }
  return null;
}

// ── Viewport meta validation ────────────────────────────────────────────
function validateViewport(content) {
  if (!content) return { present: false, valid: false, content: '' };
  const norm = content.toLowerCase().replace(/\s+/g, '');
  const valid = norm.includes('width=device-width') || /initial-scale=1(?:\.0)?/.test(norm);
  return { present: true, valid, content };
}

// ── Form analysis ───────────────────────────────────────────────────────
function analyzeForms($, baseUrl) {
  const forms = $('form').toArray();
  let contactForm = false;
  let postsHttps = true; // vacuously true if no forms; we override below
  let nonHttpsForm = false;
  for (const f of forms) {
    const html = $.html(f).toLowerCase();
    const isContact = /input[^>]+type=["']?email/.test(html)
                   || /name=["']email/.test(html)
                   || /<textarea/.test(html)
                   || /input[^>]+name=["']?(message|comments?|inquiry|details?)/i.test(html);
    if (isContact) contactForm = true;
    const action = $(f).attr('action') || '';
    if (action) {
      const abs = action.startsWith('http') ? action : safeJoinUrl(baseUrl, action);
      if (abs && abs.startsWith('http://')) nonHttpsForm = true;
    }
  }
  if (forms.length > 0 && nonHttpsForm) postsHttps = false;
  return {
    has_contact_form: contactForm,
    form_count: forms.length,
    forms_post_https: forms.length === 0 ? null : postsHttps,
  };
}

// ── Mixed-content scan ──────────────────────────────────────────────────
function countMixedContent($, finalUrl) {
  if (!finalUrl.startsWith('https://')) return 0;
  let n = 0;
  const check = (attr) => {
    $(`[${attr}]`).each((_, el) => {
      const v = $(el).attr(attr) || '';
      if (/^http:\/\//i.test(v)) n += 1;
    });
  };
  check('src');
  check('href');
  return n;
}

// ── Tech stack detection ────────────────────────────────────────────────
function detectTechStack(html) {
  const found = [];
  for (const fp of TECH_FINGERPRINTS) {
    if (fp.rx.test(html)) found.push(fp.label);
  }
  // Capture jQuery version when possible — old jQuery (1.x) is a strong
  // "site hasn't been touched in years" tell.
  const jqMatch = html.match(/jquery[-.](\d+\.\d+(?:\.\d+)?)/i);
  if (jqMatch && found.includes('jQuery')) {
    const idx = found.indexOf('jQuery');
    found[idx] = `jQuery ${jqMatch[1]}`;
  }
  const wpMatch = html.match(/wp-emoji-release\.min\.js\?ver=(\d+\.\d+)/);
  return { tech_stack: found, wp_version: wpMatch ? wpMatch[1] : '' };
}

function detectChatAndBooking(html) {
  let chat = '';
  for (const fp of CHAT_FINGERPRINTS) {
    if (fp.rx.test(html)) { chat = fp.name; break; }
  }
  let appt = '';
  for (const fp of APPOINTMENT_FINGERPRINTS) {
    if (fp.rx.test(html)) { appt = fp.name; break; }
  }
  return { chat_widget: chat, appointment_tool: appt };
}

function detectSocialLinks($, finalUrl) {
  const baseHost = extractHost(finalUrl);
  const found = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (!href.startsWith('http')) return;
    const host = extractHost(href);
    if (!host || host === baseHost) return;
    for (const [name, rx] of SOCIAL_HOSTS) {
      if (rx.test(href)) { found.add(name); break; }
    }
  });
  return [...found];
}

function detectDefaultTemplate(html) {
  for (const t of DEFAULT_TEMPLATE_TELLS) {
    if (t.rx.test(html)) return t.tell;
  }
  return '';
}

function detectCms($, html, headHtml) {
  for (const fp of CMS_FINGERPRINTS) {
    if (fp.rx.test(headHtml) || fp.rx.test(html)) return fp.cms;
  }
  const gen = $('meta[name="generator"]').attr('content');
  return gen ? gen.split(/\s+/)[0] : '';
}

// ── Phone extraction (text + tel: + schema) ─────────────────────────────
function extractPhones($, bodyText, schemaTel) {
  const set = new Set();
  // From text
  const textMatches = bodyText.match(PHONE_REGEX) || [];
  PHONE_REGEX.lastIndex = 0;
  for (const m of textMatches) {
    const n = normalizePhone(m);
    if (n) set.add(n);
  }
  // From tel: links
  $('a[href^="tel:"]').each((_, el) => {
    const n = normalizePhone($(el).attr('href') || '');
    if (n) set.add(n);
  });
  // From schema
  if (schemaTel) {
    const n = normalizePhone(schemaTel);
    if (n) set.add(n);
  }
  return [...set];
}

// ── Public: audit one URL ────────────────────────────────────────────────
async function auditUrl(rawUrl, {
  cityHints = [],
  usePageSpeed = true,
  leadPhone = '',           // optional — if provided, we flag whether it appears on the site
  crawlInternal = true,     // turn off for fastest possible audit
} = {}) {
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

  const fetched = await fetchPage(audited_url);
  const out = {
    audited_url,
    audited_at,
    final_url:           fetched.finalUrl,
    status_code:         fetched.status,
    loads_successfully:  fetched.ok && fetched.status >= 200 && fetched.status < 400,
    ssl_valid:           (fetched.finalUrl || audited_url).startsWith('https://'),
    fetch_duration_ms:   fetched.duration,
    html_bytes:          fetched.bytes,
    notes:               fetched.ok ? '' : humanizeFetchError(fetched.error),
    pages_audited:       fetched.ok ? 1 : 0,
  };

  if (!fetched.html) return out; // can't parse — return what we have

  // ── Parse homepage ───────────────────────────────────────────────────
  const $ = cheerio.load(fetched.html);
  const headHtml = $('head').html() || '';
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const fullHtml = fetched.html;

  // ── Multi-page + side probes — all in parallel ───────────────────────
  const origin = originOf(out.final_url || audited_url);
  const internalCandidates = crawlInternal
    ? discoverInternalPages($, audited_url, out.final_url)
    : [];

  const sidePromises = {
    favicon:  origin ? _httpHead(`${origin}/favicon.ico`)  : Promise.resolve({ ok: false, status: 0 }),
    robots:   origin ? _httpHead(`${origin}/robots.txt`)   : Promise.resolve({ ok: false, status: 0 }),
    sitemap:  origin ? _httpGet(`${origin}/sitemap.xml`,  { timeout: HEAD_TIMEOUT_MS, maxBytes: MAX_SITEMAP_BYTES }).catch(() => null) : Promise.resolve(null),
    pages:    Promise.all(internalCandidates.map((u) => fetchPage(u).catch(() => null))),
  };
  const side = await new Promise((resolve) => {
    const keys = Object.keys(sidePromises);
    const acc = {};
    Promise.allSettled(Object.values(sidePromises)).then((settled) => {
      settled.forEach((s, i) => { acc[keys[i]] = s.status === 'fulfilled' ? s.value : null; });
      resolve(acc);
    });
  });

  // ── Aggregate text + html across homepage + internal pages ───────────
  let combinedBodyText = bodyText;
  let combinedHtml = fullHtml;
  let contactPageUrl = '';
  let servicesPageUrl = '';
  const internalPages = (side.pages || []).filter((p) => p && p.ok && p.html);
  for (const p of internalPages) {
    const $$ = cheerio.load(p.html);
    combinedBodyText += ' ' + $$('body').text().replace(/\s+/g, ' ').trim();
    combinedHtml += '\n' + p.html;
    const lowerUrl = p.finalUrl.toLowerCase();
    if (/contact/.test(lowerUrl) && !contactPageUrl) contactPageUrl = p.finalUrl;
    if (/service/.test(lowerUrl) && !servicesPageUrl) servicesPageUrl = p.finalUrl;
    out.pages_audited += 1;
  }
  out.contact_page_url  = contactPageUrl;
  out.services_page_url = servicesPageUrl;

  // ── Viewport (validated, not just present) ──────────────────────────
  const viewport = validateViewport($('meta[name="viewport"]').attr('content') || '');
  out.has_mobile_viewport = viewport.present;
  out.viewport_content    = viewport.content;
  out.viewport_valid      = viewport.valid;

  // ── SEO basics ──────────────────────────────────────────────────────
  out.title = ($('title').first().text() || '').trim();
  out.has_title = !!out.title;
  out.meta_description = ($('meta[name="description"]').attr('content') || '').trim();
  out.has_meta_description = !!out.meta_description;
  const h1 = $('h1').first().text().trim();
  out.h1 = h1;
  out.has_h1 = !!h1;

  // ── Open Graph + Twitter card (social-share readiness) ──────────────
  out.has_og_tags = !!($('meta[property="og:title"]').attr('content')
                   && ($('meta[property="og:image"]').attr('content')
                       || $('meta[property="og:description"]').attr('content')));
  out.has_twitter_card = !!$('meta[name="twitter:card"]').attr('content');

  // ── JSON-LD with validation ─────────────────────────────────────────
  const ldItems = flattenJsonLd($);
  out.has_schema = ldItems.length > 0;
  const lb = extractLocalBusinessSchema(ldItems);
  out.has_localbusiness_schema = !!lb;
  if (lb) {
    out.schema_name      = lb.name;
    out.schema_telephone = lb.telephone;
    out.schema_address   = lb.address;
    out.localbusiness_schema_valid = !!(lb.name && lb.telephone && lb.address);
  } else {
    out.localbusiness_schema_valid = false;
  }

  // ── Phones (text + tel: + schema), cross-checked vs lead phone ──────
  const phones = extractPhones($, combinedBodyText, lb?.telephone || '');
  out.phones_found       = phones;
  out.has_visible_phone  = phones.length > 0;
  out.has_click_to_call  = $('a[href^="tel:"]').length > 0
                        || internalPages.some((p) => /<a[^>]+href=["']tel:/i.test(p.html));
  if (leadPhone) {
    const norm = normalizePhone(leadPhone);
    out.lead_phone_matches_site = !!(norm && phones.includes(norm));
  }

  // ── Forms ───────────────────────────────────────────────────────────
  const forms = analyzeForms($, out.final_url || audited_url);
  out.has_contact_form  = forms.has_contact_form
                       || internalPages.some((p) => /<form[\s>]/i.test(p.html));
  out.form_count        = forms.form_count;
  out.forms_post_https  = forms.forms_post_https;

  // ── CTA (homepage + internal pages) ─────────────────────────────────
  const ctaText = [
    ...$('a').map((_, el) => $(el).text()).get(),
    ...$('button').map((_, el) => $(el).text()).get(),
    ...$('[role="button"]').map((_, el) => $(el).text()).get(),
  ].join(' ');
  out.has_quote_cta = QUOTE_CTA_PHRASES.some((rx) =>
    rx.test(ctaText) || rx.test(combinedBodyText.slice(0, 4000))
  );
  out.has_cta_above_fold = QUOTE_CTA_PHRASES.some((rx) => rx.test(bodyText.slice(0, 1500)))
                        || $('a[href^="tel:"]').slice(0, 3).length > 0;

  // ── Services & service-area mentions (now aggregated across pages) ──
  out.has_services_list = /our\s+services|services\s+we\s+offer|what\s+we\s+do/i.test(combinedBodyText)
                       || $('nav a, header a, footer a').filter((_, el) =>
                            /services?/i.test($(el).text())).length > 0
                       || !!out.services_page_url;

  const cityMatches = (cityHints || []).filter((c) =>
    new RegExp(`\\b${escapeRegex(c)}\\b`, 'i').test(combinedBodyText)
  );
  out.has_service_area_terms = cityMatches.length > 0 || /service\s+area/i.test(combinedBodyText);
  out.service_area_count = cityMatches.length;

  // ── Reviews, gallery, map embed ─────────────────────────────────────
  out.has_reviews_on_site = REVIEW_KEYWORDS_ON_SITE.some((rx) => rx.test(combinedBodyText));
  out.has_gallery = GALLERY_KEYWORDS.some((rx) => rx.test(combinedBodyText))
                 || $('img').length >= 8;
  out.has_google_map_embed = $('iframe[src*="google.com/maps"], iframe[src*="maps.google"]').length > 0
                          || MAP_EMBED_HOSTS.some((h) => combinedHtml.toLowerCase().includes(h));

  // ── Copyright ───────────────────────────────────────────────────────
  const copyrightMatch = combinedBodyText.match(/©\s*(\d{4})|copyright\s*(?:©|\(c\))?\s*(\d{4})/i);
  if (copyrightMatch) {
    const year = parseInt(copyrightMatch[1] || copyrightMatch[2], 10);
    if (isFinite(year)) {
      out.copyright_year = year;
      out.outdated_copyright = year < new Date().getFullYear() - 1;
    }
  }

  // ── Marketing tells ─────────────────────────────────────────────────
  out.has_tracking_pixels = TRACKING_PATTERNS.some((rx) => rx.test(combinedHtml));
  const navLinks = $('nav a, header a').length;
  out.has_landing_page_structure = navLinks > 0 && navLinks <= 4
                                && bodyText.length > 3000
                                && out.has_quote_cta;

  // ── Tech stack, CMS, default-template ────────────────────────────────
  out.cms_detected = detectCms($, fullHtml, headHtml);
  const tech = detectTechStack(combinedHtml);
  out.tech_stack       = tech.tech_stack;
  out.wp_version       = tech.wp_version;
  out.is_default_template = detectDefaultTemplate(combinedHtml);

  // ── Conversion tools (chat + booking) ────────────────────────────────
  const conv = detectChatAndBooking(combinedHtml);
  out.chat_widget       = conv.chat_widget;
  out.appointment_tool  = conv.appointment_tool;
  out.has_live_chat     = !!conv.chat_widget;
  out.has_online_booking = !!conv.appointment_tool;

  // ── Social presence ─────────────────────────────────────────────────
  out.social_links = detectSocialLinks($, out.final_url || audited_url);

  // ── Mixed content (https page loading http resources) ───────────────
  out.mixed_content_count = countMixedContent($, out.final_url || audited_url);

  // ── Trust signals (HEADs + a real favicon link or fetched file) ─────
  out.has_favicon = !!(side.favicon?.ok)
                 || !!($('link[rel*="icon"]').attr('href'));
  out.has_robots_txt = !!(side.robots?.ok);
  out.has_sitemap    = !!(side.sitemap && side.sitemap.status >= 200 && side.sitemap.status < 400 && typeof side.sitemap.data === 'string');
  if (out.has_sitemap) {
    const sm = parseSitemapBody(side.sitemap.data, cityHints);
    out.sitemap_url_count = sm.count;
    // If sitemap has town URLs but body text didn't mention them, lift the
    // service-area signal. This catches sites that list service areas via
    // dedicated pages (/areas/voorhees) instead of inline mentions.
    if (sm.townMatches.length > out.service_area_count) {
      out.service_area_count = sm.townMatches.length;
      out.has_service_area_terms = true;
    }
  }

  // ── Internal anchor sanity check ─────────────────────────────────────
  const internalLinks = $('a').filter((_, el) => {
    const href = $(el).attr('href') || '';
    return href.startsWith('/') || href.startsWith('#')
        || (href.includes(extractHost(out.final_url || audited_url)) && !href.startsWith('mailto:'));
  }).length;
  out.broken_link_count = 0; // not implemented — placeholder
  if (internalLinks === 0 && fullHtml.length > 200) {
    out.notes = (out.notes ? out.notes + '; ' : '') + 'No internal links found';
  }

  // ── PageSpeed Insights (optional, async) ────────────────────────────
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

// ── Error humanizer (unchanged) ──────────────────────────────────────────
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

// ── Public wrappers (signature-compatible with v1) ───────────────────────
async function auditLead(lead, options = {}) {
  if (!lead.website_url) {
    return {
      audited_url: '',
      audited_at: new Date(),
      loads_successfully: false,
      notes: 'No website URL on lead.',
    };
  }
  const opts = { usePageSpeed: true, leadPhone: lead.phone || '', ...options };
  return auditUrl(lead.website_url, opts);
}

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
