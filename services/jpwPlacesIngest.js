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
const { guessCategory } = require('./jpwConstants');
const { fetchSpiderPhones } = require('./jpwSpiderPush');

const PLACES_DAILY_CAP = parseInt(process.env.JPW_PLACES_DAILY_CAP || '200', 10);

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
async function googlePlacesTextSearch(textQuery, { lat, lng, radius = 25000, maxResults = 20 } = {}) {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_KEY env var not set on the backend.');

  const body = {
    textQuery,
    maxResultCount: Math.min(maxResults, 20),
  };
  if (isFinite(lat) && isFinite(lng)) {
    body.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius } };
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
  return data.places || [];
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

// ── Top-level: run a search and ingest ──────────────────────────────────
async function runSearch({ category, town = '', county = '', extraQuery = '', maxResults = 20 }) {
  if (!category) throw new Error('category is required.');

  // Build the query string. Format examples:
  //   "tree service near Marlton NJ"
  //   "septic service Burlington County NJ"
  let textQuery;
  if (town) textQuery = `${category} near ${town} NJ`;
  else if (county) textQuery = `${category} ${county} County NJ`;
  else textQuery = `${category} South Jersey NJ`;
  if (extraQuery) textQuery += ` ${extraQuery}`;

  const usage = await getTodayUsage();
  if (usage.places_calls >= PLACES_DAILY_CAP) {
    throw Object.assign(new Error(`Daily Places API cap reached (${PLACES_DAILY_CAP}). Try again tomorrow or raise JPW_PLACES_DAILY_CAP.`), { statusCode: 429 });
  }

  // Cross-tab Spider dedupe — pull every phone currently in the user's
  // Spider workbook (any tab) before ingesting. If a Places result's phone
  // matches one in Spider, we skip it entirely — never even create the lead
  // in Mongo. Empty set if Spider isn't configured or the GET fails.
  const spiderPhones = await fetchSpiderPhones();

  const places = await googlePlacesTextSearch(textQuery, { maxResults });
  await incPlacesUsage(1);

  let created = 0, merged = 0, skipped = 0, skipped_in_spider = 0;
  const upserted = [];
  for (const p of places) {
    if (!p.id || !p.displayName?.text) { skipped += 1; continue; }
    const data = placeToLeadData(p, {
      sourceQuery: textQuery,
      sourceCity: town,
      sourceCounty: county,
    });
    // Spider dedupe — phone-based. We only know about phones, not place_ids,
    // because Spider rows were entered by hand. Catches the 99% case the
    // user described: businesses already in his Prospect Tracking / cold-
    // call tabs that get re-surfaced by every Places search.
    const normPhone = normalizePhone(data.phone);
    if (normPhone && spiderPhones.has(normPhone)) {
      skipped_in_spider += 1;
      continue;
    }
    try {
      const r = await upsertPlace(data);
      if (r.created) created += 1;
      else if (r.merged) merged += 1;
      upserted.push(r.lead._id);
    } catch (err) {
      console.error('[jpwPlaces] upsert failed:', err.message);
      skipped += 1;
    }
  }

  return {
    query: textQuery,
    received: places.length,
    created, merged, skipped, skipped_in_spider,
    upserted_ids: upserted,
    usage_today: usage.places_calls + 1,
    daily_cap: PLACES_DAILY_CAP,
    spider_phones_checked: spiderPhones.size,
  };
}

module.exports = {
  runSearch,
  upsertPlace,
  getTodayUsage,
  PLACES_DAILY_CAP,
};
