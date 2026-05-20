// services/jpwSpiderPush.js
//
// Pushes JPW leads into the Spider Google Sheet via an Apps Script web app
// endpoint that the user pastes into the sheet (see docs/JPW_SPIDER_SETUP.md).
//
// Why Apps Script and not the Sheets API directly:
//   - No GCP service account JSON to manage or rotate.
//   - No API enabling steps for the user.
//   - The script runs as the sheet's owner, so it inherits write access.
//   - We post JSON with a shared secret; the script validates and appends.
//
// On success the lead is stamped with pushed_to_spider_at + a dedupe key so
// repeated pushes of the same lead don't duplicate rows on the sheet side
// (the Apps Script ALSO dedupes by the same key for belt-and-suspenders).

const axios = require('axios');

const WEBHOOK_URL = process.env.JPW_SPIDER_WEBHOOK_URL || '';
const SHARED_SECRET = process.env.JPW_SPIDER_SHARED_SECRET || '';
const TARGET_TAB = process.env.JPW_SPIDER_TAB || 'JPW Recon';

function isConfigured() {
  return !!(WEBHOOK_URL && SHARED_SECRET);
}

// Shape one lead into the row the Apps Script expects. Column order MUST
// match the COLUMNS array in apps-script/JpwSpiderEndpoint.gs.
//
// Nate's CRM is Spider — Lead Recon just pre-fills the factual columns
// (business + score + recommendation) and leaves the working columns
// (status / contact dates / notes) blank for him to fill in by hand.
// Dropped from the previous version: source, last_checked, opener,
// pitch_angle, call_status — they were noise duplicating what Spider does
// or what Cold Call Tree handles.
function leadToRow(lead) {
  const score = lead.lead_score || {};
  return {
    business_name:     lead.business_name || '',
    category:          lead.category || '',
    phone:             lead.phone || '',
    website:           lead.website_url || '',
    google_maps_url:   lead.google_maps_url || '',
    address:           lead.address || '',
    city:              lead.city || '',
    county:            lead.county || '',
    rating:            lead.rating ?? '',
    review_count:      lead.review_count ?? '',
    lead_score:        score.score ?? '',
    priority_grade:    score.grade || '',
    recommended_offer: score.recommendedOffer || '',
    main_pain_point:   score.mainPainPoints?.[0] || '',
    buying_signal:     score.buyingSignals?.[0] || '',
    // Working columns — blank on push, Nate fills in via the sheet's
    // dropdowns / date pickers. The Apps Script sets data validation on
    // these columns when first creating the tab.
    status:            '',
    last_contact:      '',
    next_contact:      '',
    notes:             '',
    // Dedupe key sent to the Apps Script so it can refuse double-append.
    dedupe_key:        dedupeKeyFor(lead),
  };
}

// Stable per-lead key. Prefer place_id (authoritative), then phone, then
// domain, then normalized name+city. Mirrors the same priority the backend
// uses for in-Mongo dedupe.
function dedupeKeyFor(lead) {
  if (lead.google_place_id) return `place:${lead.google_place_id}`;
  if (lead.normalized_phone) return `phone:${lead.normalized_phone}`;
  if (lead.domain) return `domain:${lead.domain}`;
  if (lead.normalized_name && lead.normalized_city) {
    return `name:${lead.normalized_name}|${lead.normalized_city}`;
  }
  return `id:${lead._id}`;
}

// Push a single lead. Returns { ok, dedupe_key, row, message }.
async function pushLead(lead) {
  if (!isConfigured()) {
    throw new Error('Spider webhook not configured. Set JPW_SPIDER_WEBHOOK_URL and JPW_SPIDER_SHARED_SECRET on the backend.');
  }
  const payload = {
    secret: SHARED_SECRET,
    target_tab: TARGET_TAB,
    rows: [leadToRow(lead)],
  };
  const { data } = await axios.post(WEBHOOK_URL, payload, {
    timeout: 20000,
    headers: { 'Content-Type': 'application/json' },
  });
  if (!data || data.ok !== true) {
    throw new Error(data?.message || 'Apps Script returned an error.');
  }
  const r = (data.results || [])[0] || {};
  return { ok: true, dedupe_key: r.dedupe_key, row: r.row, status: r.status, message: r.message };
}

// Push many leads in one POST. Apps Script processes the array server-side
// so we keep the round-trip count low; a single push of 50 leads is one
// request, not 50.
async function pushLeadsBatch(leads) {
  if (!isConfigured()) {
    throw new Error('Spider webhook not configured. Set JPW_SPIDER_WEBHOOK_URL and JPW_SPIDER_SHARED_SECRET on the backend.');
  }
  if (!leads.length) return { ok: true, results: [] };
  const payload = {
    secret: SHARED_SECRET,
    target_tab: TARGET_TAB,
    rows: leads.map(leadToRow),
  };
  const { data } = await axios.post(WEBHOOK_URL, payload, {
    timeout: 60000,
    headers: { 'Content-Type': 'application/json' },
  });
  if (!data || data.ok !== true) {
    throw new Error(data?.message || 'Apps Script returned an error.');
  }
  return { ok: true, results: data.results || [] };
}

// ── Fetch existing phones from Spider for cross-sheet dedupe ─────────────
//
// Places searches return a lot of businesses Nate already has in his Spider
// workbook (in other tabs — Subscriptions, Prospect Tracking, his cold-call
// list). We dedupe against those by pulling every 10-digit phone from every
// tab of the sheet once and caching for 5 minutes.
//
// The Apps Script doGet(action=phones) handler does the cell-by-cell regex
// scan; this side just fetches + caches. Cache key is the webhook URL so
// changing it (e.g. rotating deployments) invalidates the old cache.
//
// Degrades gracefully: if the GET fails for any reason — network down, bad
// secret, Apps Script returning the wrong shape — we return an empty set so
// Places ingestion still runs, just without Spider dedupe for that call.

const PHONE_CACHE_TTL_MS = 5 * 60 * 1000;
const phoneCache = new Map(); // url -> { phones: Set<string>, fetchedAt: number }

async function fetchSpiderPhones({ force = false } = {}) {
  if (!isConfigured()) return new Set();
  const cached = phoneCache.get(WEBHOOK_URL);
  if (!force && cached && Date.now() - cached.fetchedAt < PHONE_CACHE_TTL_MS) {
    return cached.phones;
  }
  try {
    const { data } = await axios.get(WEBHOOK_URL, {
      params: { action: 'phones', secret: SHARED_SECRET },
      timeout: 20000,
    });
    if (!data || data.ok !== true || !Array.isArray(data.phones)) {
      throw new Error(data?.message || 'Unexpected response from Spider phones endpoint.');
    }
    const phones = new Set(data.phones);
    phoneCache.set(WEBHOOK_URL, { phones, fetchedAt: Date.now() });
    return phones;
  } catch (err) {
    console.warn('[jpwSpiderPush] fetchSpiderPhones failed:', err.message);
    return new Set();
  }
}

module.exports = {
  isConfigured,
  pushLead,
  pushLeadsBatch,
  dedupeKeyFor,
  leadToRow,
  fetchSpiderPhones,
  TARGET_TAB,
};
