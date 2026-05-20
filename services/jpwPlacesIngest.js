// services/jpwPlacesIngest.js
//
// JPW-specific Google Places ingestion. Reuses the same Places (New) Text
// Search API the road-trip tool calls — they hit the same key and quota.
//
// Inputs: a category + optional town/county. Builds a text query like
//   "tree service in Voorhees NJ"
// and ingests each result as a JpwLead via the dedupe + scoring pipeline.
//
// Cost controls (per GPT spec):
//   - Per-day call cap (PLACES_DAILY_CAP, default 200; override via env)
//   - Per-job result cap (max 20 from Places anyway, but we hard-clamp)
//   - Dedupe by place_id so re-running the same search updates rather than
//     duplicates — cheap and idempotent.

const axios = require('axios');
const JpwLead = require('../models/JpwLead');
const JpwApiUsage = require('../models/JpwApiUsage');
const { scoreLead } = require('./jpwScoring');
const { buildDedupeKeys, buildDedupeFilter, normalizePhone } = require('./jpwDedupe');
const {
  guessCategory,
  SOUTH_JERSEY_TOWN_COORDS, SOUTH_JERSEY_COUNTY_COORDS,
  PLACES_TOWN_RADIUS_M, PLACES_COUNTY_RADIUS_M,
} = require('./jpwConstants');
const { fetchSpiderPhones } = require('./jpwSpiderPush');
const { auditLeadsConcurrent } = require('./jpwAuditor');

const PLACES_DAILY_CAP = parseInt(process.env.JPW_PLACES_DAILY_CAP || '200', 10);

// Google Places (New) FieldMask. ONLY `places.*` field paths are valid here
// — top-level response keys like `nextPageToken` must NOT be listed or Google
// rejects the whole request with 400 ("Field 'nextPageToken' is not valid").
// The pagination token comes back at the top level by default regardless of
// what's in the mask.
const GOOGLE_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.googleMapsUri',
].join(',');

// ── Usage tracking ───────────────────────────────────────────────────────
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getTodayUsage() {
  const date = todayKey();
  const doc = await JpwApiUsage.findOneAndUpdate(
    { date },
    { $setOnInsert: { date, places_calls: 0, audits_run: 0 } },
    { upsert: true, new: true }
  );
  return doc;
}

async function incPlacesUsage(by = 1) {
  await JpwApiUsage.updateOne(
    { date: todayKey() },
    { $inc: { places_calls: by } },
    { upsert: true }
  );
}

// ── Address component extraction ─────────────────────────────────────────
function pickAddressComponents(components = []) {
  const out = { city: '', county: '', state: '', postal_code: '' };
  for (const c of components) {
    const types = c.types || [];
    const name = c.shortText || c.longText || '';
    if (types.includes('locality'))                       out.city = c.longText || name;
    else if (types.includes('administrative_area_level_2')) out.county = (c.longText || '').replace(/\s+County$/i, '');
    else if (types.includes('administrative_area_level_1')) out.state = c.shortText || name;
    else if (types.includes('postal_code'))               out.postal_code = name;
  }
  return out;
}

// ── Search Google Places by text query ───────────────────────────────────
//
// `locationRestriction` (hard) is preferred over `locationBias` (soft) when
// town/county coords are known — without it, Google can return businesses
// matched by name from anywhere in the world (we saw Worcestershire UK and
// Philadelphia results polluting "roofing in Voorhees" searches). Pass
// `useRestriction: false` to fall back to soft bias if coords are unknown
// or the search is intentionally global.
//
// Pagination: Google's `searchText` returns max 20 results per call but
// supports up to 3 pages via `nextPageToken`. We loop until we hit `pages`
// or there are no more results. Returns the merged places array AND the
// number of API calls actually used (the caller writes this to the API
// usage counter).
async function googlePlacesTextSearch(textQuery, {
  lat, lng,
  radius = 25000,
  pages = 1,
  useRestriction = true,
} = {}) {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_KEY env var not set on the backend.');

  const all = [];
  let pageToken = null;
  let callsUsed = 0;
  const maxPages = Math.max(1, Math.min(pages, 3));

  for (let i = 0; i < maxPages; i++) {
    const body = {
      textQuery,
      maxResultCount: 20,
    };
    if (pageToken) body.pageToken = pageToken;
    if (isFinite(lat) && isFinite(lng) && !pageToken) {
      // Google requires the restriction only on the first page; subsequent
      // pageToken requests already carry the original query context.
      const circle = { center: { latitude: lat, longitude: lng }, radius };
      if (useRestriction) body.locationRestriction = { circle };
      else                body.locationBias        = { circle };
    }

    const { data } = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': GOOGLE_FIELDS,
        },
        timeout: 15000,
      }
    );
    callsUsed += 1;
    if (Array.isArray(data.places)) all.push(...data.places);
    pageToken = data.nextPageToken || null;
    if (!pageToken) break;
    // Google sometimes needs a short pause before a freshly-issued
    // nextPageToken is valid — 250ms is the documented minimum.
    await new Promise((r) => setTimeout(r, 300));
  }

  return { places: all, calls_used: callsUsed };
}

// ── Map a Places result → JpwLead shape ──────────────────────────────────
function placeToLeadData(place, { sourceQuery, sourceCity, sourceCounty } = {}) {
  const addr = pickAddressComponents(place.addressComponents);
  const rawCategory = place.primaryTypeDisplayName?.text
                  || place.primaryType
                  || (place.types || [])[0]
                  || '';
  return {
    business_name:   place.displayName?.text || '',
    phone:           place.nationalPhoneNumber || '',
    website_url:     place.websiteUri || '',
    google_place_id: place.id || '',
    google_maps_url: place.googleMapsUri || '',
    address:         place.formattedAddress || '',
    city:            addr.city || sourceCity || '',
    county:          addr.county || sourceCounty || '',
    state:           addr.state || 'NJ',
    postal_code:     addr.postal_code || '',
    lat:             place.location?.latitude,
    lng:             place.location?.longitude,
    category:        guessCategory(rawCategory) || rawCategory,
    subcategory:     (place.types || []).join(', '),
    rating:          place.rating ?? 0,
    review_count:    place.userRatingCount ?? 0,
    business_status: place.businessStatus || 'OPERATIONAL',
    source:          'google_places',
    source_query:    sourceQuery,
    source_city:     sourceCity,
    source_county:   sourceCounty,
  };
}

// ── Ingest helper: upsert one place through dedupe → score ──────────────
async function upsertPlace(data) {
  const keys = buildDedupeKeys({
    google_place_id: data.google_place_id,
    phone:           data.phone,
    website:         data.website_url,
    name:            data.business_name,
    city:            data.city,
  });
  const enriched = {
    ...data,
    ...keys,
    last_seen_at: new Date(),
  };
  enriched.lead_score = scoreLead(enriched);

  const filter = buildDedupeFilter(enriched);
  const existing = filter ? await JpwLead.findOne(filter) : null;

  if (existing) {
    // Refresh Google-sourced fields (rating/review_count/status change over time)
    // but never overwrite manual edits to call_status / notes / owner_name.
    const refreshable = [
      'business_name', 'phone', 'website_url', 'google_maps_url', 'address',
      'city', 'county', 'state', 'postal_code', 'lat', 'lng',
      'rating', 'review_count', 'business_status', 'category', 'subcategory',
    ];
    for (const k of refreshable) {
      if (data[k] !== undefined && data[k] !== '' && data[k] !== null) {
        existing[k] = data[k];
      }
    }
    existing.normalized_name  = enriched.normalized_name;
    existing.normalized_phone = enriched.normalized_phone;
    existing.domain           = enriched.domain;
    existing.normalized_city  = enriched.normalized_city;
    existing.last_seen_at     = new Date();
    existing.lead_score       = scoreLead(existing.toObject());
    await existing.save();
    return { lead: existing, created: false, merged: true };
  }

  const created = await JpwLead.create(enriched);
  return { lead: created, created: true, merged: false };
}

// Look up the search phrases for a category. Falls back to the category
// name lowercased if `searchPhrases` isn't defined (mid-ticket categories,
// or anyone adding a new category without phrasings).
function getSearchPhrasesForCategory(category) {
  const { CATEGORIES } = require('./jpwConstants');
  const meta = CATEGORIES.find((c) => c.name === category);
  if (meta?.searchPhrases?.length) return meta.searchPhrases;
  return [category.toLowerCase()];
}

// ── Top-level: run a deep search and ingest ──────────────────────────────
//
// For each (category, town) pair we run multiple phrasings × pagination, so
// one logical "search" actually maps to ~3 phrases × 2 pages = ~6 API calls
// and surfaces up to ~80-100 unique businesses (after dedupe). The buried
// businesses Google ranks low for the default phrase often surface near the
// top of an alternate phrasing — those are typically Nate's best prospects
// (weak SEO is itself the signal).
async function runSearch({
  category, town = '', county = '', extraQuery = '',
  pagesPerPhrase = 2,
  phrases, // optional override — defaults to category's searchPhrases
}) {
  if (!category) throw new Error('category is required.');

  // Geographic anchor. Tight radius (15km for towns) keeps results local.
  let anchor;
  if (town) {
    anchor = SOUTH_JERSEY_TOWN_COORDS[town] && {
      ...SOUTH_JERSEY_TOWN_COORDS[town], radius: PLACES_TOWN_RADIUS_M,
    };
  } else if (county) {
    anchor = SOUTH_JERSEY_COUNTY_COORDS[county] && {
      ...SOUTH_JERSEY_COUNTY_COORDS[county], radius: PLACES_COUNTY_RADIUS_M,
    };
  } else {
    // No specific anchor — bias broadly to South Jersey via Camden centroid.
    anchor = { ...SOUTH_JERSEY_COUNTY_COORDS['Camden'], radius: 60_000 };
  }

  const usage = await getTodayUsage();
  if (usage.places_calls >= PLACES_DAILY_CAP) {
    throw Object.assign(new Error(`Daily Places API cap reached (${PLACES_DAILY_CAP}). Try again tomorrow or raise JPW_PLACES_DAILY_CAP.`), { statusCode: 429 });
  }

  // Pre-fetch the cross-tab Spider phone set so we can skip leads Nate
  // already has anywhere in his workbook (Prospect Tracking, cold-call
  // list, etc.). Cached for 5 min server-side; cheap if it hits.
  const spiderPhones = await fetchSpiderPhones();

  // Build the phrase list. Each phrase becomes one search-text query, all
  // anchored to the same town/county circle. Buried-in-Google businesses
  // surface for one phrase but not another, so the union catches them.
  const phraseList = (phrases && phrases.length) ? phrases : getSearchPhrasesForCategory(category);
  const anchorSuffix = town ? ` near ${town} NJ` : (county ? ` ${county} County NJ` : ' South Jersey NJ');

  let apiCalls = 0;
  // Dedupe across phrasings: merge by place_id so we don't run the same
  // business through the upsert pipeline three times.
  const mergedByPlaceId = new Map();
  const queriesTried = [];

  for (const phrase of phraseList) {
    const textQuery = `${phrase}${anchorSuffix}${extraQuery ? ' ' + extraQuery : ''}`;
    queriesTried.push(textQuery);

    // Stop early if we're about to bust the daily cap.
    const remaining = PLACES_DAILY_CAP - (usage.places_calls + apiCalls);
    if (remaining < 1) break;
    const pagesForThisPhrase = Math.min(pagesPerPhrase, Math.max(1, remaining));

    const { places, calls_used } = await googlePlacesTextSearch(textQuery, {
      pages: pagesForThisPhrase,
      lat: anchor?.lat, lng: anchor?.lng, radius: anchor?.radius,
      useRestriction: !!anchor,
    });
    apiCalls += calls_used;
    for (const p of places) {
      if (p?.id && !mergedByPlaceId.has(p.id)) mergedByPlaceId.set(p.id, p);
    }
  }

  if (apiCalls > 0) await incPlacesUsage(apiCalls);

  const places = Array.from(mergedByPlaceId.values());
  let created = 0, merged = 0, skipped = 0, skipped_in_spider = 0;
  const upserted = [];
  const newLeadIds = []; // leads to send through the background auditor
  const primaryQuery = queriesTried[0] || `${category}${anchorSuffix}`;
  for (const p of places) {
    if (!p.id || !p.displayName?.text) { skipped += 1; continue; }
    const data = placeToLeadData(p, {
      sourceQuery: primaryQuery,
      sourceCity: town,
      sourceCounty: county,
    });
    // We searched by phrasings of `category` — make sure we tag the lead
    // with our canonical category, not whatever Google decided to call its
    // `primaryType`. Otherwise a Roofing search that happens to return a
    // "General Contractor" gets miscategorized.
    if (!data.category) data.category = category;
    // Spider dedupe — phone-based.
    const normPhone = normalizePhone(data.phone);
    if (normPhone && spiderPhones.has(normPhone)) {
      skipped_in_spider += 1;
      continue;
    }
    try {
      const r = await upsertPlace(data);
      if (r.created) { created += 1; newLeadIds.push(r.lead._id); }
      else if (r.merged) merged += 1;
      upserted.push(r.lead._id);
    } catch (err) {
      console.error('[jpwPlaces] upsert failed:', err.message);
      skipped += 1;
    }
  }

  // Fire-and-forget auto-audit so freshly ingested leads have a populated
  // Pain score by the time the user clicks into them. Skipped if a lead
  // was already audited within 14 days (handled in auditLeadsConcurrent).
  if (newLeadIds.length) {
    setImmediate(() => triggerBackgroundAudit(newLeadIds).catch((e) =>
      console.warn('[jpwPlaces] background audit error:', e.message)));
  }

  return {
    query: primaryQuery,
    queries_tried: queriesTried,
    phrases_run: phraseList.length,
    api_calls_used: apiCalls,
    received: places.length,
    created, merged, skipped, skipped_in_spider,
    upserted_ids: upserted,
    auto_audit_queued: newLeadIds.length,
    usage_today: usage.places_calls + apiCalls,
    daily_cap: PLACES_DAILY_CAP,
    spider_phones_checked: spiderPhones.size,
  };
}

// ── Background auto-audit ─────────────────────────────────────────────────
//
// Pulls the just-created leads back out of Mongo (we only kept ids) and
// runs them through the auditor with concurrency 4. The auditor itself
// skips leads audited within 14 days. PSI is left off here because it
// adds 20s+ per lead — too slow for a "freshly searched" UX.
async function triggerBackgroundAudit(leadIds) {
  if (!leadIds || !leadIds.length) return;
  const leads = await JpwLead.find({ _id: { $in: leadIds }, website_url: { $ne: '' } });
  if (!leads.length) return;
  const results = await auditLeadsConcurrent(leads, {
    concurrency: 4,
    usePageSpeed: false,
    skipIfAuditedWithinDays: 14,
  });
  // Save each audited lead — auditLeadsConcurrent mutates `audit` only, the
  // controller is normally responsible for saving. Since we're the
  // controller here, do it inline.
  for (const { lead, audit, error } of results) {
    if (error || !audit) continue;
    lead.website_audit = audit;
    lead.lead_score = scoreLead(lead.toObject());
    try { await lead.save(); }
    catch (e) { console.warn('[jpwPlaces] bg-audit save failed:', e.message); }
  }
}

// ── Smart pair queue ─────────────────────────────────────────────────────
//
// The full cross-product is `high-ticket categories × SJ towns` = ~496 pairs.
// Without memory of which pairs have been run, Nate's sweeps would hit the
// same ones over and over. The history doc (JpwSweepPairHistory) records
// last_ran_at + last_result_count per pair. We pick the N least-recently-
// run pairs each time, with zero-yield pairs deprioritized for 14 days so
// we don't burn API quota on combos that returned nothing last time.
const { CATEGORIES, SOUTH_JERSEY_TOWNS } = require('./jpwConstants');
const JpwSweepPairHistory = require('../models/JpwSweepPairHistory');
const JpwSchedulerState   = require('../models/JpwSchedulerState');

function buildFullCrossProduct() {
  const cats = CATEGORIES.filter((c) => c.tier === 'high').map((c) => c.name);
  const out = [];
  for (const category of cats) {
    for (const town of SOUTH_JERSEY_TOWNS) out.push({ category, town });
  }
  return out;
}

async function getNextSweepPairs(n) {
  const all = buildFullCrossProduct();
  // Pull all history docs once — even with 500 pairs this is tiny.
  const histories = await JpwSweepPairHistory.find({}).lean();
  const byKey = new Map();
  for (const h of histories) byKey.set(`${h.category}::${h.town}`, h);

  const now = Date.now();
  const ZERO_YIELD_COOLDOWN_MS = 14 * 86400000; // 14 days

  const decorated = all.map((p) => {
    const h = byKey.get(`${p.category}::${p.town}`);
    if (!h) return { ...p, last_ran_at: null, dead_until: 0 };
    const dead = (h.last_result_count === 0)
      ? new Date(h.last_ran_at).getTime() + ZERO_YIELD_COOLDOWN_MS
      : 0;
    return { ...p, last_ran_at: h.last_ran_at, dead_until: dead };
  });

  // Sort:
  //   1) Pairs whose dead-zone has expired (or never had one) come first
  //   2) Among those, oldest last_ran_at first (null = never run = highest priority)
  //   3) Stable by name
  decorated.sort((a, b) => {
    const aDead = a.dead_until > now ? 1 : 0;
    const bDead = b.dead_until > now ? 1 : 0;
    if (aDead !== bDead) return aDead - bDead;
    const at = a.last_ran_at ? new Date(a.last_ran_at).getTime() : 0;
    const bt = b.last_ran_at ? new Date(b.last_ran_at).getTime() : 0;
    if (at !== bt) return at - bt;
    return (a.category + a.town).localeCompare(b.category + b.town);
  });
  return decorated.slice(0, n).map((p) => ({ category: p.category, town: p.town }));
}

async function recordPairHistory(pair, result, apiCalls) {
  await JpwSweepPairHistory.findOneAndUpdate(
    { category: pair.category, town: pair.town || '' },
    {
      $set: {
        category: pair.category,
        town: pair.town || '',
        last_ran_at: new Date(),
        last_result_count: result.received,
        last_created: result.created,
        last_merged: result.merged,
        last_skipped_in_spider: result.skipped_in_spider,
        last_api_calls_used: apiCalls,
      },
      $inc: { total_runs: 1 },
    },
    { upsert: true, new: true }
  );
}

// ── Async sweep with progress tracking ───────────────────────────────────
//
// Returns immediately with a job started flag. The actual loop runs via
// setImmediate, updates JpwSchedulerState (job: 'manual_sweep') every pair,
// and writes per-pair history. The frontend polls /api/jpw/search/sweep/
// status to render a live progress bar.
//
// `runSweep` (synchronous version) is kept for the scheduler's existing
// weekly cron — it just awaits the loop here.

const SWEEP_JOB = 'manual_sweep';

async function _getSweepState() {
  return JpwSchedulerState.findOne({ job: SWEEP_JOB }).lean();
}

async function _setSweepState(patch) {
  return JpwSchedulerState.findOneAndUpdate(
    { job: SWEEP_JOB },
    { $set: { job: SWEEP_JOB, ...patch } },
    { upsert: true, new: true }
  );
}

async function startSweepInBackground({ maxSearches = 30, pairs = null, pagesPerPhrase = 2 } = {}) {
  const existing = await _getSweepState();
  if (existing && existing.status === 'running') {
    return { ok: false, message: 'A sweep is already running.', state: existing };
  }

  const cap = Math.min(Math.max(parseInt(maxSearches, 10) || 30, 1), 100);
  const queue = (Array.isArray(pairs) && pairs.length) ? pairs.slice(0, cap) : await getNextSweepPairs(cap);

  const started_at = new Date();
  await _setSweepState({
    status: 'running',
    pairs_done: 0,
    pairs_total: queue.length,
    current_pair: '',
    api_calls_used: 0,
    total_created: 0,
    total_merged: 0,
    total_skipped: 0,
    total_skipped_in_spider: 0,
    stop_requested: false,
    started_at,
    ran_at: started_at,
    finished_at: null,
    halted_reason: '',
    error: '',
  });

  setImmediate(() => _runSweepLoop(queue, pagesPerPhrase).catch((err) => {
    console.error('[jpwPlaces] sweep loop fatal:', err.message);
    _setSweepState({ status: 'failed', error: err.message, finished_at: new Date() })
      .catch(() => {});
  }));

  return { ok: true, message: 'Sweep started.', pairs_total: queue.length };
}

async function _runSweepLoop(queue, pagesPerPhrase) {
  let pairs_done = 0;
  let api_calls_used = 0;
  let total_created = 0;
  let total_merged = 0;
  let total_skipped = 0;
  let total_skipped_in_spider = 0;
  let pair_failures = 0;
  let last_error_message = '';
  let halted_reason = '';

  for (const pair of queue) {
    const cur = await _getSweepState();
    if (cur?.stop_requested) {
      halted_reason = 'Stopped by user.';
      break;
    }

    const label = `${pair.town || pair.county || 'SJ'} · ${pair.category}`;
    await _setSweepState({ current_pair: label, ran_at: new Date() });

    try {
      const result = await runSearch({
        category: pair.category,
        town: pair.town || '',
        county: pair.county || '',
        pagesPerPhrase,
      });
      pairs_done += 1;
      api_calls_used         += result.api_calls_used || 0;
      total_created          += result.created;
      total_merged           += result.merged;
      total_skipped          += result.skipped;
      total_skipped_in_spider += result.skipped_in_spider;
      await recordPairHistory(pair, result, result.api_calls_used || 0);
    } catch (err) {
      if (err.statusCode === 429) {
        halted_reason = err.message || 'Daily Places cap reached.';
        break;
      }
      pair_failures += 1;
      // Capture more than `err.message` — Places API errors typically wrap a
      // useful detail object in axios's `response.data` that explains exactly
      // why the request was rejected (e.g. "Invalid FieldMask"). Without this
      // we'd see "Request failed with status code 400" and nothing else.
      last_error_message = err.response?.data?.error?.message
                        || JSON.stringify(err.response?.data || {}).slice(0, 200)
                        || err.message
                        || 'unknown';
      console.warn(`[jpwPlaces] sweep search failed (${label}): ${last_error_message}`);
    }

    await _setSweepState({
      pairs_done, api_calls_used,
      total_created, total_merged, total_skipped, total_skipped_in_spider,
      ran_at: new Date(),
    });

    await new Promise((r) => setTimeout(r, 400));
  }

  // If every pair in the queue failed (and the queue wasn't empty), this is
  // a real problem worth surfacing — not a "completed" run. Common cause: a
  // mis-formed request to Google (e.g. an invalid FieldMask) that kills
  // every single search. Set status to 'failed' so the dialog shows red.
  const allFailed = queue.length > 0 && pairs_done === 0 && !halted_reason && pair_failures > 0;
  const finalStatus = halted_reason
    ? 'stopped'
    : allFailed ? 'failed' : 'completed';
  const finalError = allFailed
    ? `All ${pair_failures} searches failed. Last error: ${last_error_message}`
    : '';

  await _setSweepState({
    status: finalStatus,
    halted_reason: halted_reason || (allFailed ? 'Every search returned an error — see error field.' : ''),
    error: finalError,
    finished_at: new Date(),
    current_pair: '',
    pairs_done, api_calls_used,
    total_created, total_merged, total_skipped, total_skipped_in_spider,
  });
}

async function getSweepStatus() {
  const state = await _getSweepState();
  return state || { status: 'idle' };
}

async function requestSweepStop() {
  const state = await _getSweepState();
  if (!state || state.status !== 'running') {
    return { ok: false, message: 'No sweep is currently running.' };
  }
  await _setSweepState({ stop_requested: true });
  return { ok: true, message: 'Stop requested. Will halt after the current pair finishes.' };
}

// ── Legacy sync sweep — kept for the existing weekly cron in scheduler ───
async function runSweep({ pairs = [], maxSearches = 30, delayMs = 400 } = {}) {
  const cap = Math.min(parseInt(maxSearches, 10) || 30, 100);
  const queue = pairs.slice(0, cap);
  let searches_run = 0;
  let total_created = 0;
  let total_merged = 0;
  let total_skipped = 0;
  let total_skipped_in_spider = 0;
  let api_calls_used = 0;
  let halted_reason = '';

  for (const pair of queue) {
    try {
      const result = await runSearch({
        category: pair.category,
        town: pair.town || '',
        county: pair.county || '',
      });
      searches_run += 1;
      api_calls_used         += result.api_calls_used || 0;
      total_created          += result.created;
      total_merged           += result.merged;
      total_skipped          += result.skipped;
      total_skipped_in_spider += result.skipped_in_spider;
      await recordPairHistory(pair, result, result.api_calls_used || 0);
    } catch (err) {
      if (err.statusCode === 429) {
        halted_reason = err.message || 'Daily Places cap reached.';
        break;
      }
      console.warn('[jpwPlaces] sweep search failed:', err.message);
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  return {
    searches_run,
    pairs_total: queue.length,
    total_created, total_merged, total_skipped, total_skipped_in_spider,
    api_calls_used,
    halted_reason,
  };
}

module.exports = {
  runSearch,
  runSweep,
  startSweepInBackground,
  getSweepStatus,
  requestSweepStop,
  getNextSweepPairs,
  upsertPlace,
  getTodayUsage,
  triggerBackgroundAudit,
  PLACES_DAILY_CAP,
};
