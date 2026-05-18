// controllers/placeSearch.js
//
// Proxies three external APIs and normalizes their responses into a single
// shape the frontend can consume without caring about source. All API keys
// are read from env vars and never leave the server.
//
// Output shape for every search endpoint:
//   {
//     source: 'google_places' | 'nps' | 'ridb',
//     externalId: string,
//     name: string, address: string, phone: string, website: string,
//     lat: number, lng: number,
//     type: 'dispensary' | 'coffee' | 'park_national' | 'campground',
//     rating: number | null,
//     extras: { ...source-specific bonus fields }
//   }

const axios = require('axios');
const DispensaryDenylist = require('../models/DispensaryDenylist');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse + validate lat/lng/radius from query string.
 * Radius is in meters and capped at 50 km (Google Places' hard limit for
 * nearby search; we apply the same cap to other sources for consistency).
 */
function parseGeoQuery(req) {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = Math.min(parseInt(req.query.radius, 10) || 16093, 50000);
  if (!isFinite(lat) || !isFinite(lng)) {
    const err = new Error('lat and lng query params are required.');
    err.statusCode = 400;
    throw err;
  }
  return { lat, lng, radius };
}

/**
 * Haversine distance in meters — used to filter NPS/RIDB results that come
 * back state-wide or otherwise unfiltered by radius.
 */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Crude heuristic to weed out non-dispensaries from a dispensary search —
// smoke shops, vape stores, AND medical-card doctor referrals and the like
// that show up under "marijuana" search terms but aren't places to pitch
// merch. Conservative — false-negative is better than false-positive.
// The denylist catches stragglers the admin manually flags from the UI.
const SMOKE_SHOP_KEYWORDS = [
  /\bsmoke\s*shop/i, /\bvape\b/i, /\bhookah\b/i, /\btobacco\b/i,
  /\bcigar/i, /\bhead\s*shop/i, /\bglass\s*gallery/i, /\bcbd\s+only\b/i,
  // Non-dispensary services that show up under "marijuana" queries:
  /marijuana\s+certifications?/i,      // medical card doctor referrals
  /marijuana\s+(doctors?|md|physicians?|evaluations?|clinic)/i,
  /marijuana\s+display/i,              // display-case manufacturers
  /dispensary\s+doctor/i,
];
const looksLikeSmokeShop = (name = '') =>
  SMOKE_SHOP_KEYWORDS.some((rx) => rx.test(name));

// ─────────────────────────────────────────────────────────────────────────────
// Known multi-state operator (MSO) detection.
//
// Each entry pairs a regex (case-insensitive) with the canonical brand name.
// When a dispensary's name matches, we tag the result so the frontend can
// render chains differently — same trip, different sales approach.
//
// False negatives are fine (an unmatched name shows as a one-off, which is
// the safer default). The first match wins; broader patterns last.
// ─────────────────────────────────────────────────────────────────────────────
const DISPENSARY_CHAINS = [
  // Big east-coast MSOs first. Patterns are intentionally loose enough to
  // match the actual Google Places names you see in the wild, which often
  // include qualifiers like "Medical and Adult Use" rather than the brand's
  // own word "Dispensary".
  [/curaleaf/i,                                  'Curaleaf'],
  [/trulieve/i,                                  'Trulieve'],
  [/\brise\s+(medical|adult|dispens|cannabis|recreational|marijuana)/i, 'RISE (GTI)'],
  [/sunnyside/i,                                 'Sunnyside (Cresco)'],
  [/verilife|pharmacann/i,                       'Verilife (Pharmacann)'],
  [/cannabist|columbia\s+care/i,                 'Cannabist (Columbia Care)'],
  [/liberty\s+health\s+sciences|\bLHS\b/i,       'Liberty Health Sciences'],
  [/ayr\s*wellness|\bayr\b\s+(medical|cannabis|dispens|recreational|marijuana)/i, 'AYR Wellness'],
  [/beyond[\s/-]*hello|\bjushi\b/i,              'Beyond/Hello (Jushi)'],
  [/ascend\s+(wellness|dispens|medical|cannabis|recreational|marijuana)/i, 'Ascend'],
  [/the\s+botanist|acreage/i,                    'The Botanist (Acreage)'],
  [/apothecarium|terrascend|\bgage\b/i,          'TerrAscend (Apothecarium/Gage)'],
  [/zen\s+leaf|verano|\bmüv\b|\bmuv\b/i,         'Zen Leaf (Verano)'],
  [/theory\s+wellness/i,                         'Theory Wellness'],
  [/\bneta\b/i,                                  'NETA'],
  [/harvest\s+(of|hoc|dispens|cannabis|medical|marijuana)/i, 'Harvest'],
  [/\bmedmen\b/i,                                'MedMen'],
  [/cookies\s+(retail|dispens|cannabis|on\b)/i,  'Cookies'],
  [/\binsa\b/i,                                  'Insa'],
  [/\betain\b/i,                                 'Etain'],
  [/cresco\s+labs?/i,                            'Cresco Labs'],
  [/green\s+thumb\s+industries|\bGTI\b/i,        'Green Thumb Industries'],
];

function detectChain(name = '') {
  for (const [rx, label] of DISPENSARY_CHAINS) {
    if (rx.test(name)) return label;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Google Places (New) — Text Search and Nearby Search
// ─────────────────────────────────────────────────────────────────────────────

const GOOGLE_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.types',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.googleMapsUri',
].join(',');

async function googleTextSearch({ textQuery, lat, lng, radius }) {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_KEY env var not set on the backend.');

  const { data } = await axios.post(
    'https://places.googleapis.com/v1/places:searchText',
    {
      textQuery,
      maxResultCount: 20,
      locationBias: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius,
        },
      },
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': GOOGLE_FIELDS,
      },
      timeout: 15_000,
    }
  );
  return data.places || [];
}

async function googleNearbySearch({ includedTypes, lat, lng, radius }) {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) throw new Error('GOOGLE_PLACES_KEY env var not set on the backend.');

  const { data } = await axios.post(
    'https://places.googleapis.com/v1/places:searchNearby',
    {
      includedTypes,
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius,
        },
      },
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': GOOGLE_FIELDS,
      },
      timeout: 15_000,
    }
  );
  return data.places || [];
}

function normalizeGoogle(place, type) {
  return {
    source: 'google_places',
    externalId: place.id || '',
    name: place.displayName?.text || '',
    address: place.formattedAddress || '',
    phone: place.nationalPhoneNumber || '',
    website: place.websiteUri || '',
    lat: place.location?.latitude,
    lng: place.location?.longitude,
    type,
    rating: place.rating ?? null,
    extras: {
      ratingCount: place.userRatingCount ?? null,
      businessStatus: place.businessStatus,
      googleMapsUri: place.googleMapsUri,
      types: place.types || [],
    },
  };
}

// ── Endpoint: dispensaries ───────────────────────────────────────────────────
async function searchDispensaries(req, res) {
  try {
    const { lat, lng, radius } = parseGeoQuery(req);

    // Two passes — text searches catch different result sets. Dedupe by
    // place_id at the end.
    const [rawA, rawB] = await Promise.all([
      googleTextSearch({ textQuery: 'marijuana dispensary recreational', lat, lng, radius }),
      googleTextSearch({ textQuery: 'cannabis dispensary',                lat, lng, radius }),
    ]);

    const denied = new Set(
      (await DispensaryDenylist.find({}, { placeId: 1 }).lean()).map((d) => d.placeId)
    );

    const seen = new Set();
    const merged = [];
    for (const p of [...rawA, ...rawB]) {
      if (!p.id || seen.has(p.id)) continue;
      if (denied.has(p.id)) continue;
      const name = p.displayName?.text || '';
      if (looksLikeSmokeShop(name)) continue;
      seen.add(p.id);
      const normalized = normalizeGoogle(p, 'dispensary');
      const chainName = detectChain(name);
      normalized.isChain   = !!chainName;
      normalized.chainName = chainName; // null for one-offs
      merged.push(normalized);
    }

    res.json({ count: merged.length, results: merged });
  } catch (err) {
    console.error('[placeSearch] dispensaries error:', err.response?.data || err.message);
    res.status(err.statusCode || 500).json({
      message: err.message || 'Dispensary search failed.',
      detail:  err.response?.data || null,
    });
  }
}

// ── Endpoint: coffee shops (sit-down places to work, not gas-station coffee) ─
//
// `cafe` as a Google Places type is overbroad — it returns Wawa, 7-Eleven,
// Sheetz, etc. The user wants actual sit-down places with wifi where they
// can work. Two-pronged fix:
//   1. Use text search for "coffee shop" / "cafe wifi" — better intent match.
//   2. Filter out any result tagged gas_station or convenience_store.
const SIT_DOWN_BLOCKED_TYPES = new Set(['gas_station', 'convenience_store']);
const SIT_DOWN_NAME_BLOCKLIST = [
  /\bwawa\b/i, /\b7[- ]?eleven\b/i, /\bsheetz\b/i, /\bsunoco\b/i,
  /\bshell\b/i, /\bmobil\b/i, /\bexxon\b/i, /\bbp\b/i, /\bchevron\b/i,
  /\bcumberland farms\b/i, /\bquiktrip\b/i, /\bspeedway\b/i, /\bgas station\b/i,
];

async function searchCoffee(req, res) {
  try {
    const { lat, lng, radius } = parseGeoQuery(req);

    const [a, b] = await Promise.all([
      googleTextSearch({ textQuery: 'coffee shop',         lat, lng, radius }),
      googleTextSearch({ textQuery: 'cafe with wifi',      lat, lng, radius }),
    ]);

    const seen = new Set();
    const results = [];
    for (const p of [...a, ...b]) {
      if (!p.id || seen.has(p.id)) continue;
      const name = p.displayName?.text || '';
      const types = p.types || [];
      if (types.some((t) => SIT_DOWN_BLOCKED_TYPES.has(t))) continue;
      if (SIT_DOWN_NAME_BLOCKLIST.some((rx) => rx.test(name))) continue;
      seen.add(p.id);
      results.push(normalizeGoogle(p, 'coffee'));
    }

    res.json({ count: results.length, results });
  } catch (err) {
    console.error('[placeSearch] coffee error:', err.response?.data || err.message);
    res.status(err.statusCode || 500).json({
      message: err.message || 'Coffee search failed.',
      detail:  err.response?.data || null,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NPS — National parks within a state, distance-filtered
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quick lat/lng → US state-code mapping for the eight states the East Coast
 * trip touches. NPS doesn't accept lat/lng directly — you query by state.
 * Approximation is fine; results get distance-filtered after.
 *
 * Expand this table when the longer west-coast trip happens.
 */
function approxStateFromLatLng(lat, lng) {
  // Rough bounding-box checks for NE corridor states. Order matters where
  // boxes overlap — we return the first match.
  const inBox = (latMin, latMax, lngMin, lngMax) =>
    lat >= latMin && lat <= latMax && lng >= lngMin && lng <= lngMax;

  if (inBox(38.93, 39.84, -75.79, -75.05)) return 'DE';
  if (inBox(38.93, 39.72, -79.49, -75.05)) return 'MD';
  if (inBox(38.78, 39.00, -77.12, -76.91)) return 'DC';
  if (inBox(40.49, 40.92, -74.26, -73.70)) return 'NY'; // NYC area
  if (inBox(40.65, 41.10, -73.55, -71.86)) return 'CT';
  if (inBox(41.14, 42.02, -71.86, -71.12)) return 'RI';
  if (inBox(41.24, 42.89, -73.51, -69.93)) return 'MA';
  if (inBox(42.73, 45.02, -73.44, -71.50)) return 'VT';
  if (inBox(42.70, 45.31, -71.50, -70.61)) return 'NH';
  if (inBox(43.06, 47.46, -71.08, -66.95)) return 'ME';
  if (inBox(38.93, 41.36, -74.39, -73.89)) return 'NJ';
  if (inBox(39.72, 42.27, -80.52, -74.69)) return 'PA';
  if (inBox(40.49, 45.02, -79.76, -71.85)) return 'NY';
  return null;
}

async function searchNpsParks(req, res) {
  try {
    const { lat, lng, radius } = parseGeoQuery(req);
    const key = process.env.NPS_KEY;
    if (!key) throw new Error('NPS_KEY env var not set on the backend.');

    const state = approxStateFromLatLng(lat, lng);
    const params = { limit: 100, api_key: key };
    if (state) params.stateCode = state;

    const { data } = await axios.get('https://developer.nps.gov/api/v1/parks', {
      params, timeout: 15_000,
    });

    const results = (data.data || [])
      .map((p) => ({
        source: 'nps',
        externalId: p.parkCode || '',
        name: p.fullName || p.name || '',
        address: (p.addresses && p.addresses[0]?.line1) || '',
        phone:   (p.contacts?.phoneNumbers && p.contacts.phoneNumbers[0]?.phoneNumber) || '',
        website: p.url || '',
        lat:     parseFloat(p.latitude),
        lng:     parseFloat(p.longitude),
        type:    'park_national',
        rating:  null,
        extras: {
          designation: p.designation,
          description: p.description,
          activities:  (p.activities || []).map((a) => a.name),
          states:      p.states,
        },
      }))
      .filter((p) => isFinite(p.lat) && isFinite(p.lng))
      .filter((p) => haversineMeters(lat, lng, p.lat, p.lng) <= radius)
      .sort((a, b) => haversineMeters(lat, lng, a.lat, a.lng)
                    - haversineMeters(lat, lng, b.lat, b.lng));

    res.json({ count: results.length, results });
  } catch (err) {
    console.error('[placeSearch] NPS error:', err.response?.data || err.message);
    res.status(err.statusCode || 500).json({
      message: err.message || 'NPS search failed.',
      detail:  err.response?.data || null,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RIDB — Federal campgrounds (Recreation.gov), distance-filtered
// ─────────────────────────────────────────────────────────────────────────────

async function searchCampgrounds(req, res) {
  try {
    const { lat, lng, radius } = parseGeoQuery(req);
    const key = process.env.RIDB_KEY;
    if (!key) throw new Error('RIDB_KEY env var not set on the backend.');

    // RIDB's /facilities endpoint supports lat/lng/radius (radius in miles,
    // max 50). Convert our meters to miles.
    const radiusMiles = Math.min(Math.round(radius / 1609.34), 50);

    const { data } = await axios.get('https://ridb.recreation.gov/api/v1/facilities', {
      params: {
        latitude:  lat,
        longitude: lng,
        radius:    radiusMiles,
        limit:     50,
        activity:  'CAMPING',  // restrict to facilities that have camping
      },
      headers: { apikey: key, accept: 'application/json' },
      timeout: 20_000,
    });

    const results = (data.RECDATA || [])
      .map((f) => ({
        source: 'ridb',
        externalId: String(f.FacilityID || ''),
        name:    f.FacilityName || '',
        address: '', // RIDB has it nested separately — skip for v1
        phone:   f.FacilityPhone || '',
        website: f.FacilityReservationURL || '',
        lat:     parseFloat(f.FacilityLatitude),
        lng:     parseFloat(f.FacilityLongitude),
        type:    'campground',
        rating:  null,
        extras: {
          description: f.FacilityDescription,
          reservable:  f.Reservable,
          typeDescription: f.FacilityTypeDescription,
        },
      }))
      .filter((p) => isFinite(p.lat) && isFinite(p.lng) && (p.lat !== 0 || p.lng !== 0));

    res.json({ count: results.length, results });
  } catch (err) {
    console.error('[placeSearch] RIDB error:', err.response?.data || err.message);
    res.status(err.statusCode || 500).json({
      message: err.message || 'Campground search failed.',
      detail:  err.response?.data || null,
    });
  }
}

module.exports = {
  searchDispensaries,
  searchCoffee,
  searchNpsParks,
  searchCampgrounds,
};
