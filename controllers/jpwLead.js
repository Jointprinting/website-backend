// controllers/jpwLead.js
//
// CRUD + import + scoring for JP Webworks leads. All routes admin-only (set
// in the route file). Re-scoring runs on every create/update so the lead
// score sub-doc is always fresh — scoring is cheap and we'd rather have one
// source of truth (the doc) than a stale field that diverges from reality.

const JpwLead = require('../models/JpwLead');
const JpwApiUsage = require('../models/JpwApiUsage');
const { scoreLead } = require('../services/jpwScoring');
const {
  buildDedupeKeys, buildDedupeFilter,
  normalizePhone, normalizeDomain, normalizeName, normalizeCity,
} = require('../services/jpwDedupe');
const {
  SOUTH_JERSEY_TOWNS, SOUTH_JERSEY_COUNTIES, CATEGORIES,
  guessCategory, SCORE_CAPS, SCORE_TOTAL_CAP,
} = require('../services/jpwConstants');
const { runSearch, getTodayUsage, PLACES_DAILY_CAP } = require('../services/jpwPlacesIngest');
const { auditLead, auditLeadsConcurrent } = require('../services/jpwAuditor');
const { pushLead, pushLeadsBatch, dedupeKeyFor, isConfigured: isSpiderConfigured } = require('../services/jpwSpiderPush');

// ── Field whitelist ───────────────────────────────────────────────────────
// Only these fields can be set from the request body. Everything else (dedupe
// keys, lead_score, timestamps) is derived on the server.
const ALLOWED_FIELDS = [
  'business_name', 'phone', 'website_url', 'email',
  'google_place_id', 'google_maps_url',
  'address', 'city', 'county', 'state', 'postal_code', 'lat', 'lng',
  'address_residential_only',
  'category', 'subcategory', 'is_franchise',
  'rating', 'review_count', 'business_status',
  'source', 'source_query', 'source_city', 'source_county',
  // sub-docs that can be set wholesale on create
  'website_audit', 'ad_signal',
  // call queue
  'call_status', 'owner_name', 'last_contacted_at', 'next_follow_up_at', 'call_notes',
];

function pickAllowed(body = {}) {
  const out = {};
  for (const k of ALLOWED_FIELDS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  if (out.rating !== undefined)        out.rating = parseFloat(out.rating) || 0;
  if (out.review_count !== undefined)  out.review_count = parseInt(out.review_count, 10) || 0;
  if (out.lat !== undefined)           out.lat = parseFloat(out.lat);
  if (out.lng !== undefined)           out.lng = parseFloat(out.lng);
  if (out.is_franchise !== undefined)  out.is_franchise = out.is_franchise === true || out.is_franchise === 'true';
  return out;
}

// Fill the derived fields (normalized keys, category guess, score). Pure —
// returns a new object without mutating input.
function enrich(data) {
  const out = { ...data };
  const keys = buildDedupeKeys({
    google_place_id: out.google_place_id,
    phone: out.phone,
    website: out.website_url,
    name: out.business_name,
    city: out.city,
  });
  out.normalized_name  = keys.normalized_name;
  out.normalized_phone = keys.normalized_phone;
  out.domain           = keys.domain;
  out.normalized_city  = keys.normalized_city;
  if (!out.category && out.subcategory) out.category = guessCategory(out.subcategory);
  if (out.category)    out.category = guessCategory(out.category) || out.category;
  out.last_seen_at = new Date();
  out.lead_score = scoreLead(out);
  return out;
}

// ── List leads ─────────────────────────────────────────────────────────────
async function listLeads(req, res) {
  try {
    const {
      grade, call_status, category, county, city,
      has_website, recommended_offer, min_score, max_score,
      sort = 'score_desc', limit = 500,
    } = req.query;

    const filter = {};
    if (grade)         filter['lead_score.grade'] = grade;
    if (call_status)   filter.call_status = call_status;
    if (category)      filter.category = category;
    if (county)        filter.county = county;
    if (city)          filter.city = city;
    if (recommended_offer) filter['lead_score.recommendedOffer'] = recommended_offer;
    if (has_website === 'true')  filter.website_url = { $ne: '' };
    if (has_website === 'false') filter.$or = [{ website_url: '' }, { website_url: { $exists: false } }];
    if (min_score) filter['lead_score.score'] = { ...filter['lead_score.score'], $gte: parseInt(min_score, 10) };
    if (max_score) filter['lead_score.score'] = { ...filter['lead_score.score'], $lte: parseInt(max_score, 10) };

    const sortMap = {
      score_desc:        { 'lead_score.score': -1, updatedAt: -1 },
      score_asc:         { 'lead_score.score':  1, updatedAt: -1 },
      buying_intent:     { 'lead_score.breakdown.buyingIntent': -1, 'lead_score.score': -1 },
      ability_to_pay:    { 'lead_score.breakdown.abilityToPay': -1, 'lead_score.score': -1 },
      review_count:      { review_count: -1 },
      newest:            { createdAt: -1 },
      updated:           { updatedAt: -1 },
    };

    const leads = await JpwLead.find(filter)
      .sort(sortMap[sort] || sortMap.score_desc)
      .limit(Math.min(parseInt(limit, 10) || 500, 2000))
      .lean();

    res.json({ count: leads.length, leads });
  } catch (err) {
    console.error('[jpwLead] list error:', err);
    res.status(500).json({ message: 'Failed to list leads.' });
  }
}

// ── Single lead ────────────────────────────────────────────────────────────
async function getLead(req, res) {
  try {
    const lead = await JpwLead.findById(req.params.id).lean();
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    res.json(lead);
  } catch (err) {
    console.error('[jpwLead] get error:', err);
    res.status(500).json({ message: 'Failed to fetch lead.' });
  }
}

// ── Create or upsert ──────────────────────────────────────────────────────
//
// If a dedupe match exists, update it in place (merging non-empty fields
// from the new payload). Otherwise insert. Returns whichever doc was
// touched, plus a `matched` flag so the UI can distinguish.
async function createLead(req, res) {
  try {
    const data = pickAllowed(req.body);
    if (!data.business_name) return res.status(400).json({ message: 'business_name is required.' });

    const enriched = enrich(data);
    const dedupeFilter = buildDedupeFilter(enriched);
    let matched = false;
    let saved;

    if (dedupeFilter) {
      const existing = await JpwLead.findOne(dedupeFilter);
      if (existing) {
        matched = true;
        // Merge — fill blanks on the existing doc with new info, but don't
        // overwrite fields the existing record already has (manually entered
        // notes etc.). Score is always re-computed on the merged result.
        for (const [k, v] of Object.entries(enriched)) {
          if (v === undefined || v === null || v === '') continue;
          if (existing[k] === undefined || existing[k] === null || existing[k] === '' || existing[k] === 0) {
            existing[k] = v;
          }
        }
        // Always refresh last_seen_at and re-score with the merged data
        existing.last_seen_at = new Date();
        existing.lead_score = scoreLead(existing.toObject());
        saved = await existing.save();
      }
    }

    if (!saved) {
      saved = await JpwLead.create(enriched);
    }
    res.status(matched ? 200 : 201).json({ matched, lead: saved });
  } catch (err) {
    console.error('[jpwLead] create error:', err);
    res.status(500).json({ message: 'Failed to create lead.' });
  }
}

// ── Update ─────────────────────────────────────────────────────────────────
async function updateLead(req, res) {
  try {
    const lead = await JpwLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });

    const updates = pickAllowed(req.body);
    for (const [k, v] of Object.entries(updates)) {
      lead[k] = v;
    }

    // Recompute dedupe keys + score on any change. Cheap, keeps things sane.
    const keys = buildDedupeKeys({
      google_place_id: lead.google_place_id,
      phone:           lead.phone,
      website:         lead.website_url,
      name:            lead.business_name,
      city:            lead.city,
    });
    lead.normalized_name  = keys.normalized_name;
    lead.normalized_phone = keys.normalized_phone;
    lead.domain           = keys.domain;
    lead.normalized_city  = keys.normalized_city;
    lead.lead_score = scoreLead(lead.toObject());

    const saved = await lead.save();
    res.json(saved);
  } catch (err) {
    console.error('[jpwLead] update error:', err);
    res.status(500).json({ message: 'Failed to update lead.' });
  }
}

// ── Delete ─────────────────────────────────────────────────────────────────
async function deleteLead(req, res) {
  try {
    const lead = await JpwLead.findByIdAndDelete(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    console.error('[jpwLead] delete error:', err);
    res.status(500).json({ message: 'Failed to delete lead.' });
  }
}

// ── Re-score all (or filtered) leads ──────────────────────────────────────
//
// Useful after tweaking scoring weights or after a batch website audit.
async function rescoreLeads(req, res) {
  try {
    const filter = {};
    if (req.body?.grade) filter['lead_score.grade'] = req.body.grade;
    if (req.body?.category) filter.category = req.body.category;
    const leads = await JpwLead.find(filter);
    let updated = 0;
    for (const lead of leads) {
      lead.lead_score = scoreLead(lead.toObject());
      await lead.save();
      updated += 1;
    }
    res.json({ updated });
  } catch (err) {
    console.error('[jpwLead] rescore error:', err);
    res.status(500).json({ message: 'Failed to rescore leads.' });
  }
}

// ── CSV import (Apify / OutScraper / Maps scraper exports) ────────────────
//
// Accepts a JSON array of raw row objects. We map common column names from
// the popular Maps scrapers (Apify Google Maps Scraper, OutScraper) to our
// schema, then upsert through createLead's dedupe path so duplicates merge.
//
// Body shape: { rows: [...], source?: string, source_query?: string,
//               source_city?: string, source_county?: string }

const ROW_FIELD_ALIASES = {
  business_name: ['business_name', 'name', 'title', 'companyName', 'placeName'],
  phone:         ['phone', 'phoneNumber', 'phone_number', 'tel', 'phone_1'],
  website_url:   ['website', 'website_url', 'url', 'site', 'webSite'],
  email:         ['email', 'email_1', 'emailAddress'],
  google_place_id: ['place_id', 'placeId', 'google_place_id', 'gmaps_place_id'],
  google_maps_url: ['google_maps_url', 'google_url', 'gmaps_url', 'mapsUrl', 'url_google'],
  address:       ['address', 'street_address', 'full_address', 'streetAddress'],
  city:          ['city', 'locality', 'town'],
  county:        ['county', 'administrativeArea', 'county_name'],
  state:         ['state', 'region', 'administrative_area_level_1'],
  postal_code:   ['postal_code', 'postalCode', 'zip', 'zipcode'],
  lat:           ['lat', 'latitude'],
  lng:           ['lng', 'lon', 'longitude'],
  category:      ['category', 'categoryName', 'industry', 'main_category'],
  subcategory:   ['subcategory', 'subCategory', 'types', 'categories'],
  rating:        ['rating', 'totalScore', 'avg_rating', 'average_rating'],
  review_count:  ['review_count', 'reviews', 'reviewsCount', 'review_count_1', 'user_ratings_total'],
  business_status: ['business_status', 'businessStatus', 'status_google'],
};

function mapRow(row) {
  const out = {};
  for (const [target, aliases] of Object.entries(ROW_FIELD_ALIASES)) {
    for (const a of aliases) {
      if (row[a] !== undefined && row[a] !== null && row[a] !== '') {
        out[target] = row[a];
        break;
      }
    }
  }
  // Subcategory might come in as an array (Apify "categories"); flatten.
  if (Array.isArray(out.subcategory)) out.subcategory = out.subcategory.join(', ');
  if (Array.isArray(out.category))    out.category    = out.category[0];
  return out;
}

async function importCsv(req, res) {
  try {
    const { rows = [], source = 'csv', source_query = '', source_city = '', source_county = '' } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ message: 'rows array required.' });
    }
    if (rows.length > 5000) {
      return res.status(400).json({ message: 'Import limited to 5000 rows per batch.' });
    }

    let created = 0;
    let merged = 0;
    let skipped = 0;
    const errors = [];

    for (const raw of rows) {
      try {
        const mapped = mapRow(raw);
        if (!mapped.business_name) { skipped += 1; continue; }

        const data = pickAllowed({
          ...mapped,
          source,
          source_query: source_query || mapped.source_query,
          source_city:  source_city  || mapped.city,
          source_county: source_county,
        });
        const enriched = enrich(data);
        const dedupeFilter = buildDedupeFilter(enriched);

        let existing = null;
        if (dedupeFilter) existing = await JpwLead.findOne(dedupeFilter);

        if (existing) {
          for (const [k, v] of Object.entries(enriched)) {
            if (v === undefined || v === null || v === '') continue;
            if (existing[k] === undefined || existing[k] === null || existing[k] === '' || existing[k] === 0) {
              existing[k] = v;
            }
          }
          existing.last_seen_at = new Date();
          existing.lead_score = scoreLead(existing.toObject());
          await existing.save();
          merged += 1;
        } else {
          await JpwLead.create(enriched);
          created += 1;
        }
      } catch (rowErr) {
        errors.push({ row: raw.business_name || raw.name || '(unknown)', message: rowErr.message });
      }
    }

    res.json({ received: rows.length, created, merged, skipped, errors });
  } catch (err) {
    console.error('[jpwLead] import error:', err);
    res.status(500).json({ message: 'Import failed.' });
  }
}

// ── Dashboard counts ──────────────────────────────────────────────────────
async function getDashboardStats(_req, res) {
  try {
    const all = await JpwLead.aggregate([
      { $facet: {
          total:        [{ $count: 'n' }],
          byGrade:      [{ $group: { _id: '$lead_score.grade', n: { $sum: 1 } } }],
          byOffer:      [{ $group: { _id: '$lead_score.recommendedOffer', n: { $sum: 1 } } }],
          byStatus:     [{ $group: { _id: '$call_status', n: { $sum: 1 } } }],
          activeAds:    [{ $match: { 'ad_signal.active_ads_found': true } }, { $count: 'n' }],
          noWebsite:    [{ $match: { $or: [{ website_url: '' }, { website_url: { $exists: false } }] } }, { $count: 'n' }],
          weakSite:     [{ $match: { $and: [
                            { website_url: { $ne: '' } },
                            { $or: [
                              { 'website_audit.has_click_to_call': false },
                              { 'website_audit.has_quote_cta': false },
                              { 'website_audit.loads_successfully': false },
                            ]},
                          ]}}, { $count: 'n' }],
        },
      },
    ]);

    const facet = all[0] || {};
    const flatten = (arr) => Object.fromEntries((arr || []).map((x) => [x._id || 'unknown', x.n]));
    res.json({
      total: facet.total?.[0]?.n || 0,
      byGrade: flatten(facet.byGrade),
      byOffer: flatten(facet.byOffer),
      byStatus: flatten(facet.byStatus),
      activeAds: facet.activeAds?.[0]?.n || 0,
      noWebsite: facet.noWebsite?.[0]?.n || 0,
      weakSite:  facet.weakSite?.[0]?.n || 0,
    });
  } catch (err) {
    console.error('[jpwLead] stats error:', err);
    res.status(500).json({ message: 'Failed to compute stats.' });
  }
}

// ── Reference data (towns, counties, categories, score caps) ─────────────
//
// Lets the frontend stay in sync with whatever the backend considers a
// valid town/category without hard-coding the list in two places.
function getReferenceData(_req, res) {
  res.json({
    towns: SOUTH_JERSEY_TOWNS,
    counties: SOUTH_JERSEY_COUNTIES,
    categories: CATEGORIES,
    score_caps: SCORE_CAPS,
    score_total_cap: SCORE_TOTAL_CAP,
  });
}

// ── CSV export ────────────────────────────────────────────────────────────
//
// Returns leads as CSV in Spider's column format. Phase 3 swaps this for a
// direct Sheets append, but the format stays the same.
const SPIDER_COLUMNS = [
  ['business_name',           'Business Name'],
  ['category',                'Category'],
  ['phone',                   'Phone'],
  ['website_url',             'Website'],
  ['google_maps_url',         'Google Maps URL'],
  ['address',                 'Address'],
  ['city',                    'City'],
  ['county',                  'County'],
  ['rating',                  'Rating'],
  ['review_count',            'Review Count'],
  ['lead_score.score',        'Lead Score'],
  ['lead_score.grade',        'Priority Grade'],
  ['lead_score.recommendedOffer', 'Recommended Offer'],
  ['lead_score.mainPainPoints[0]', 'Main Pain Point'],
  ['lead_score.buyingSignals[0]',  'Buying Signal'],
  ['lead_score.pitchAngle',   'Pitch Angle'],
  ['call_status',             'Status'],
  ['updatedAt',               'Last Checked'],
  ['source',                  'Source'],
  ['call_notes',              'Notes'],
];

function pickPath(obj, path) {
  // Supports dotted paths + simple [n] array indexes ("a.b[0]")
  return path.split('.').reduce((acc, seg) => {
    if (acc === undefined || acc === null) return undefined;
    const m = seg.match(/^([^\[]+)(?:\[(\d+)\])?$/);
    if (!m) return undefined;
    const key = m[1];
    const idx = m[2];
    let v = acc[key];
    if (idx !== undefined && Array.isArray(v)) v = v[parseInt(idx, 10)];
    return v;
  }, obj);
}

function csvEscape(v) {
  if (v === undefined || v === null) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function exportCsv(req, res) {
  try {
    const ids = (req.query.ids || '').split(',').filter(Boolean);
    const filter = ids.length ? { _id: { $in: ids } } : {};
    if (!ids.length && req.query.grade) filter['lead_score.grade'] = req.query.grade;
    const leads = await JpwLead.find(filter).lean();

    const header = SPIDER_COLUMNS.map(([_, label]) => csvEscape(label)).join(',');
    const lines = leads.map((lead) =>
      SPIDER_COLUMNS.map(([path]) => csvEscape(pickPath(lead, path))).join(',')
    );
    const csv = [header, ...lines].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="jpw-leads-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[jpwLead] export error:', err);
    res.status(500).json({ message: 'Export failed.' });
  }
}

// ── Bulk status update (used by the call queue action buttons) ───────────
async function bulkStatus(req, res) {
  try {
    const { ids, status, notes } = req.body || {};
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ message: 'ids array required.' });
    if (!status) return res.status(400).json({ message: 'status required.' });

    const setBlock = { call_status: status, updatedAt: new Date() };
    if (notes) setBlock.call_notes = notes;
    if (['called_no_answer', 'left_voicemail', 'interested', 'booked', 'gatekeeper'].includes(status)) {
      setBlock.last_contacted_at = new Date();
    }
    const result = await JpwLead.updateMany({ _id: { $in: ids } }, { $set: setBlock });
    res.json({ matched: result.matchedCount, modified: result.modifiedCount });
  } catch (err) {
    console.error('[jpwLead] bulkStatus error:', err);
    res.status(500).json({ message: 'Bulk status update failed.' });
  }
}

// ── Places discovery ──────────────────────────────────────────────────────
//
// POST /api/jpw/search/places
//   body: { category, town?, county?, extra_query?, max_results? }
//
// Runs a Google Places Text Search via services/jpwPlacesIngest, dedupes
// against existing leads, scores each, and returns counts + new IDs.
async function searchPlaces(req, res) {
  try {
    const { category, town = '', county = '', extra_query = '', max_results } = req.body || {};
    if (!category) return res.status(400).json({ message: 'category is required.' });
    const result = await runSearch({
      category, town, county, extraQuery: extra_query,
      maxResults: parseInt(max_results, 10) || 20,
    });
    res.json(result);
  } catch (err) {
    console.error('[jpwLead] searchPlaces error:', err.response?.data || err.message);
    res.status(err.statusCode || 500).json({
      message: err.message || 'Places search failed.',
      detail:  err.response?.data || null,
    });
  }
}

// ── Audit one lead's website ─────────────────────────────────────────────
//
// POST /api/jpw/leads/:id/audit
// Fetches the lead's website, runs the auditor, stores into website_audit,
// re-runs scoreLead, saves, and returns the updated lead.
async function auditOneLead(req, res) {
  try {
    const lead = await JpwLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    if (!lead.website_url) {
      return res.status(400).json({ message: 'Lead has no website URL to audit.' });
    }
    const audit = await auditLead(lead, { cityHints: SOUTH_JERSEY_TOWNS });
    lead.website_audit = audit;
    lead.lead_score = scoreLead(lead.toObject());
    await JpwApiUsage.updateOne({ date: new Date().toISOString().slice(0, 10) },
      { $inc: { audits_run: 1 } }, { upsert: true });
    const saved = await lead.save();
    res.json(saved);
  } catch (err) {
    console.error('[jpwLead] auditOne error:', err);
    res.status(500).json({ message: err.message || 'Audit failed.' });
  }
}

// ── Audit a batch ────────────────────────────────────────────────────────
//
// POST /api/jpw/audit-batch
//   body: { ids?, only_unaudited?, only_grade?, limit?, concurrency? }
//
// Either pass an explicit array of ids, or filter by grade / only_unaudited.
// Runs auditor with bounded concurrency, scores each result, saves them.
// Returns counts; the frontend can refetch to see updated audit data.
async function auditBatch(req, res) {
  try {
    const {
      ids,
      only_unaudited = false,
      only_grade,
      limit = 50,
      concurrency = 4,
    } = req.body || {};

    const filter = { website_url: { $ne: '' } };
    if (Array.isArray(ids) && ids.length) filter._id = { $in: ids };
    if (only_grade) filter['lead_score.grade'] = only_grade;
    if (only_unaudited) {
      filter.$or = [
        { 'website_audit.audited_at': { $exists: false } },
        { 'website_audit.audited_at': null },
      ];
    }

    const leads = await JpwLead.find(filter).limit(Math.min(parseInt(limit, 10) || 50, 250));
    if (!leads.length) return res.json({ audited: 0, errors: 0, message: 'No leads matched the filter.' });

    const results = await auditLeadsConcurrent(leads, {
      concurrency: Math.min(parseInt(concurrency, 10) || 4, 8),
      cityHints: SOUTH_JERSEY_TOWNS,
    });

    let audited = 0, errors = 0;
    for (const { lead, audit, error } of results) {
      if (error || !audit) { errors += 1; continue; }
      lead.website_audit = audit;
      lead.lead_score = scoreLead(lead.toObject());
      try { await lead.save(); audited += 1; }
      catch (err) { errors += 1; console.error('[jpwLead] audit save error:', err.message); }
    }
    await JpwApiUsage.updateOne({ date: new Date().toISOString().slice(0, 10) },
      { $inc: { audits_run: audited } }, { upsert: true });

    res.json({ requested: leads.length, audited, errors });
  } catch (err) {
    console.error('[jpwLead] auditBatch error:', err);
    res.status(500).json({ message: err.message || 'Batch audit failed.' });
  }
}

// ── Usage snapshot for the dashboard ─────────────────────────────────────
async function getUsage(_req, res) {
  try {
    const today = await getTodayUsage();
    res.json({
      date: today.date,
      places_calls_today: today.places_calls,
      audits_run_today:   today.audits_run,
      daily_cap:          PLACES_DAILY_CAP,
      places_key_configured: !!process.env.GOOGLE_PLACES_KEY,
      spider_configured:     isSpiderConfigured(),
    });
  } catch (err) {
    console.error('[jpwLead] getUsage error:', err);
    res.status(500).json({ message: 'Failed to fetch usage.' });
  }
}

// ── Push to Spider (one) ──────────────────────────────────────────────────
//
// POST /api/jpw/leads/:id/push-to-spider
// Stamps pushed_to_spider_at on success so the UI can show "Pushed at X"
// and so we never spam-append the same lead twice.
async function pushOneToSpider(req, res) {
  try {
    const lead = await JpwLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    const result = await pushLead(lead.toObject());
    lead.pushed_to_spider_at  = new Date();
    lead.pushed_to_spider_key = result.dedupe_key || dedupeKeyFor(lead.toObject());
    await lead.save();
    res.json({ ok: true, lead, status: result.status, row: result.row });
  } catch (err) {
    console.error('[jpwLead] pushOneToSpider error:', err.message);
    res.status(500).json({ message: err.message || 'Push to Spider failed.' });
  }
}

// ── Push to Spider (batch) ────────────────────────────────────────────────
//
// POST /api/jpw/push-to-spider-batch
//   body: { ids?: string[], grade?: 'A+'|'A'|..., only_unpushed?: boolean,
//           limit?: number }
//
// Without `ids`, defaults to "A+/A leads that haven't been pushed yet" so
// you can hit one button to fan out the call queue.
async function pushBatchToSpider(req, res) {
  try {
    const { ids, grade, only_unpushed = true, limit = 100 } = req.body || {};
    const filter = {};
    if (Array.isArray(ids) && ids.length) {
      filter._id = { $in: ids };
    } else {
      filter['lead_score.grade'] = grade
        ? grade
        : { $in: ['A+', 'A'] };
      if (only_unpushed) {
        filter.$or = [
          { pushed_to_spider_at: { $exists: false } },
          { pushed_to_spider_at: null },
        ];
      }
    }
    const leads = await JpwLead.find(filter).limit(Math.min(parseInt(limit, 10) || 100, 500));
    if (!leads.length) return res.json({ ok: true, requested: 0, pushed: 0, skipped: 0, results: [] });

    const result = await pushLeadsBatch(leads.map((l) => l.toObject()));
    const byKey = {};
    for (const r of result.results) byKey[r.dedupe_key] = r;

    let pushed = 0, skipped = 0;
    for (const lead of leads) {
      const key = dedupeKeyFor(lead.toObject());
      const r = byKey[key] || {};
      if (r.status === 'appended') {
        lead.pushed_to_spider_at  = new Date();
        lead.pushed_to_spider_key = key;
        await lead.save();
        pushed += 1;
      } else if (r.status === 'already_present') {
        // Sheet already had it — stamp so the UI hides the button next time
        if (!lead.pushed_to_spider_at) {
          lead.pushed_to_spider_at  = new Date();
          lead.pushed_to_spider_key = key;
          await lead.save();
        }
        skipped += 1;
      }
    }
    res.json({ ok: true, requested: leads.length, pushed, skipped, results: result.results });
  } catch (err) {
    console.error('[jpwLead] pushBatchToSpider error:', err.message);
    res.status(500).json({ message: err.message || 'Batch push to Spider failed.' });
  }
}

// ── Manual ad-signal entry (Meta Ad Library notes) ───────────────────────
//
// POST /api/jpw/leads/:id/ad-signal
//   body: { active_ads_found, active_ad_count, confidence, page_url, page_id,
//           page_name, ad_text_samples, landing_page_urls, ad_angle_summary,
//           first_seen_date, latest_seen_date, manual_notes, matched_keywords }
//
// Stored into lead.ad_signal, then re-scored so buying-intent points kick in.
async function updateAdSignal(req, res) {
  try {
    const lead = await JpwLead.findById(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });

    const body = req.body || {};
    const cleanArray = (v) => Array.isArray(v) ? v : (v ? [v] : []);
    const next = {
      ...lead.ad_signal?.toObject?.() || {},
      source: body.source || 'manual',
    };
    const keys = [
      'active_ads_found', 'active_ad_count', 'confidence',
      'page_url', 'page_id', 'page_name',
      'ad_angle_summary', 'manual_notes',
      'first_seen_date', 'latest_seen_date',
    ];
    for (const k of keys) {
      if (body[k] !== undefined) next[k] = body[k];
    }
    if (body.ad_text_samples !== undefined)   next.ad_text_samples   = cleanArray(body.ad_text_samples);
    if (body.landing_page_urls !== undefined) next.landing_page_urls = cleanArray(body.landing_page_urls);
    if (body.ad_snapshot_urls !== undefined)  next.ad_snapshot_urls  = cleanArray(body.ad_snapshot_urls);
    if (body.matched_keywords !== undefined)  next.matched_keywords  = cleanArray(body.matched_keywords);

    lead.ad_signal = next;
    lead.lead_score = scoreLead(lead.toObject());
    const saved = await lead.save();
    res.json(saved);
  } catch (err) {
    console.error('[jpwLead] updateAdSignal error:', err);
    res.status(500).json({ message: 'Failed to update ad signal.' });
  }
}

module.exports = {
  listLeads, getLead, createLead, updateLead, deleteLead,
  rescoreLeads, importCsv, getDashboardStats, getReferenceData,
  exportCsv, bulkStatus,
  searchPlaces, auditOneLead, auditBatch, getUsage,
  pushOneToSpider, pushBatchToSpider, updateAdSignal,
};
