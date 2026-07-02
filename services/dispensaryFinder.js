// services/dispensaryFinder.js
//
// FREE, key-less dispensary discovery via the OpenStreetMap Overpass API.
// OSM tags dispensaries as `shop=cannabis` (and some as `office=cannabis` /
// `amenity` variants), each carrying name + address + often website/phone —
// and sometimes the email itself (`contact:email`). This is a genuinely free,
// nationwide source: no billing, no API key, unlike Google Places (which bills
// per Text Search call and is deliberately NOT used here — the owner wants zero
// lead-finding spend).
//
// Flow: pick a REGION (a bounding box) → build one Overpass QL query → POST it
// to a public interpreter → parse the elements into candidate leads. The
// enrichment (scraping the website for a missing email) and the CRM import live
// in leadFinderRunner.js; this file only DISCOVERS.
//
// Coverage rollout is region-by-region (owner: "start NJ, move outward when it
// runs out"). REGIONS is ordered NJ-first; ADJACENT lists the sensible next
// hops once NJ is worked through.

const axios = require('axios');

// Public Overpass endpoints — we try them in order so one being down/rate-limited
// doesn't stall the sweep. All free.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const POLITE_UA = 'JointPrintingLeadFinder/1.0 (+https://jointprinting.com)';
const OVERPASS_TIMEOUT_MS = 90_000;

// Bounding boxes: [south, west, north, east]. NJ first; neighbors staged for the
// "expand when NJ is dry" rollout. Rec-legal states are prioritized.
const REGIONS = {
  nj: { label: 'New Jersey',   bbox: [38.85, -75.60, 41.36, -73.88] },
  ny: { label: 'New York',     bbox: [40.48, -79.77, 45.02, -71.85] },
  pa: { label: 'Pennsylvania', bbox: [39.71, -80.53, 42.27, -74.68] },
  ct: { label: 'Connecticut',  bbox: [40.95, -73.74, 42.06, -71.78] },
  de: { label: 'Delaware',     bbox: [38.44, -75.80, 39.84, -75.03] },
  md: { label: 'Maryland',     bbox: [37.88, -79.49, 39.72, -75.04] },
  ma: { label: 'Massachusetts',bbox: [41.23, -73.51, 42.89, -69.86] },
};
const DEFAULT_REGION = 'nj';
// Suggested expansion order once a region is worked through (NJ → its neighbors).
const ADJACENT = { nj: ['ny', 'pa', 'de'], ny: ['ct', 'ma', 'pa'], pa: ['md', 'de'] };

function regionIds() { return Object.keys(REGIONS); }
function isRegion(id) { return Object.prototype.hasOwnProperty.call(REGIONS, id); }

// One Overpass QL query for every cannabis retailer in a bbox. We match the
// tag combos OSM actually uses for dispensaries, on nodes AND ways (buildings),
// and ask for `center` so a way returns a lat/lon too. Pure + testable.
function buildOverpassQuery(bbox) {
  const b = bbox.join(',');
  return `[out:json][timeout:80];
(
  node["shop"="cannabis"](${b});
  way["shop"="cannabis"](${b});
  node["office"="cannabis"](${b});
  way["office"="cannabis"](${b});
  node["shop"="weed"](${b});
);
out center tags;`;
}

// Assemble the OSM address tags into the single "123 Main St, City ST 07102"
// string the CRM stores (and that services/outreachEngine.cityFromAddress can
// parse a city out of). Missing pieces are simply omitted. Pure.
function osmAddress(tags = {}) {
  const line1 = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ').trim();
  const city = (tags['addr:city'] || '').trim();
  const state = (tags['addr:state'] || '').trim();
  const zip = (tags['addr:postcode'] || '').trim();
  const locality = [city, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(' ').trim();
  return [line1, locality].filter(Boolean).join(', ');
}

// Normalize a website tag to a fetchable https URL ('' if unusable). Pure.
function normalizeWebsite(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (/^www\./i.test(s)) s = `http://${s}`;
  if (!/^https?:\/\//i.test(s)) {
    // Bare domain like "greenleaf.com" → assume http; a scheme-less "/path" is junk.
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s)) s = `http://${s}`;
    else return '';
  }
  return s;
}

// Overpass JSON → candidate leads. One per named element; unnamed elements are
// dropped (a lead with no company name is useless). De-dupes by lowercased
// name+address within the batch. Pure + testable.
function parseOverpassElements(json) {
  const elements = (json && Array.isArray(json.elements)) ? json.elements : [];
  const seen = new Set();
  const out = [];
  for (const el of elements) {
    const tags = el.tags || {};
    const name = String(tags.name || tags['official_name'] || tags['brand'] || '').trim();
    if (!name) continue;
    const address = osmAddress(tags);
    const key = `${name.toLowerCase()}|${address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      address,
      website: normalizeWebsite(tags.website || tags['contact:website'] || tags['website:official']),
      phone: String(tags.phone || tags['contact:phone'] || tags['phone:mobile'] || '').trim(),
      // OSM sometimes carries the email outright — a free hit, no scrape needed.
      email: String(tags.email || tags['contact:email'] || '').trim().toLowerCase(),
      osmId: el.type && el.id != null ? `${el.type}/${el.id}` : '',
    });
  }
  return out;
}

// Discover dispensaries in a region (network). Tries each Overpass endpoint in
// turn; returns { region, label, candidates }. Throws only if every endpoint
// fails, so the caller can surface a clean error.
async function fetchDispensaries(regionId = DEFAULT_REGION) {
  const id = isRegion(regionId) ? regionId : DEFAULT_REGION;
  const region = REGIONS[id];
  const query = buildOverpassQuery(region.bbox);
  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await axios.post(endpoint, `data=${encodeURIComponent(query)}`, {
        timeout: OVERPASS_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': POLITE_UA },
        validateStatus: () => true,
        maxContentLength: 25 * 1024 * 1024,
      });
      if (res.status === 200 && res.data) {
        return { region: id, label: region.label, candidates: parseOverpassElements(res.data) };
      }
      lastErr = new Error(`Overpass ${endpoint} → HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All Overpass endpoints failed');
}

module.exports = {
  REGIONS,
  DEFAULT_REGION,
  ADJACENT,
  regionIds,
  isRegion,
  fetchDispensaries,
  // pure — unit-tested
  buildOverpassQuery,
  osmAddress,
  normalizeWebsite,
  parseOverpassElements,
};
