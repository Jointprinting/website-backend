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

// Known-chain detection now lives in services/dispensaryChains.js (shared
// with the roster ingest so live Google results and DB rows agree).
const { detectKnownChain: detectChain } = require('../services/dispensaryChains');

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

/**
 * Core dispensary text search reused by both the HTTP endpoint and the
 * density/area tool. Two text-search passes (different queries catch
 * different result sets), then dedupe by place_id, drop denylisted IDs,
 * drop names that look like smoke shops / doctor referrals, and tag chains.
 */
async function runDispensaryTextScan({ lat, lng, radius }) {
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
  return merged;
}

async function searchDispensaries(req, res) {
  try {
    const { lat, lng, radius } = parseGeoQuery(req);
    const merged = await runDispensaryTextScan({ lat, lng, radius });
    res.json({ count: merged.length, results: merged });
  } catch (err) {
    console.error('[placeSearch] dispensaries error:', err.response?.data || err.message);
    res.status(err.statusCode || 500).json({
      message: err.message || 'Dispensary search failed.',
      detail:  err.response?.data || null,
    });
  }
}

module.exports = {
  searchDispensaries,
  // Exposed for use by controllers/dispensary.js (the "sweep this area" diff):
  runDispensaryTextScan,
};
