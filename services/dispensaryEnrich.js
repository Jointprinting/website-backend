// services/dispensaryEnrich.js
//
// Google Places enrichment for Dispensary rows: one Text Search per store
// (query = "name, address") fills phone / website / rating / businessStatus /
// placeId / googleMapsUri and refines coordinates. Runs in small batches
// driven by the frontend (it enriches what the owner is actually looking at
// first), so spend stays inside the monthly free tier instead of a big
// up-front sweep. A result only counts when it plausibly IS the store:
// within ~800 m of our geocode (when we have one) or sharing a name token.

const axios = require('axios');
const Dispensary = require('../models/Dispensary');

const GOOGLE_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
  'places.nationalPhoneNumber',
  'places.websiteUri',
  'places.googleMapsUri',
].join(',');

function distMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function sharesNameToken(a = '', b = '') {
  const tok = (s) => new Set(String(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !['the', 'and', 'dispensary', 'cannabis', 'marijuana'].includes(w)));
  const A = tok(a), B = tok(b);
  for (const w of A) if (B.has(w)) return true;
  return false;
}

async function searchOne(doc, key) {
  const body = {
    textQuery: `${doc.name}, ${doc.address || ''} ${doc.city || ''} ${doc.state}`.trim(),
    maxResultCount: 3,
  };
  if (doc.lat != null && doc.lng != null) {
    body.locationBias = { circle: { center: { latitude: doc.lat, longitude: doc.lng }, radius: 5000 } };
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
      timeout: 15_000,
    }
  );
  const places = data.places || [];
  for (const p of places) {
    const plat = p.location?.latitude, plng = p.location?.longitude;
    const nameOk = sharesNameToken(doc.name, p.displayName?.text || '');
    const distOk = doc.lat != null && plat != null
      ? distMeters(doc.lat, doc.lng, plat, plng) <= 800
      : nameOk; // no coords to compare — require a name match
    if (nameOk || distOk) return p;
  }
  return null;
}

/**
 * Enrich up to `limit` un-enriched dispensaries, optionally restricted to a
 * bbox (the caller sends the current viewport so what the owner is looking
 * at wins). Returns per-store outcomes for the ingest/coverage UI.
 */
async function enrichBatch({ bbox = null, state = null, limit = 15 } = {}) {
  const key = process.env.GOOGLE_PLACES_KEY;
  if (!key) throw Object.assign(new Error('GOOGLE_PLACES_KEY env var not set.'), { statusCode: 500 });

  const filter = { active: true, hidden: false, enrichedAt: null };
  if (state) filter.state = state;
  if (bbox) {
    filter.lat = { $gte: bbox.minLat, $lte: bbox.maxLat };
    filter.lng = { $gte: bbox.minLng, $lte: bbox.maxLng };
  }
  const docs = await Dispensary.find(filter).limit(Math.min(limit, 25));
  let enriched = 0, noMatch = 0, failed = 0;
  for (const doc of docs) {
    try {
      const p = await searchOne(doc, key);
      if (p) {
        doc.placeId = p.id || doc.placeId;
        doc.phone = p.nationalPhoneNumber || doc.phone;
        doc.website = p.websiteUri || doc.website;
        doc.rating = p.rating ?? doc.rating;
        doc.ratingCount = p.userRatingCount ?? doc.ratingCount;
        doc.businessStatus = p.businessStatus || doc.businessStatus;
        doc.googleMapsUri = p.googleMapsUri || doc.googleMapsUri;
        if (p.location?.latitude != null) { doc.lat = p.location.latitude; doc.lng = p.location.longitude; }
        if (p.businessStatus === 'CLOSED_PERMANENTLY') doc.active = false;
        enriched++;
      } else {
        noMatch++;
      }
      // Either way, stamp it so the batch pointer advances — a no-match store
      // retries only when the owner explicitly re-runs enrichment.
      doc.enrichedAt = new Date();
      await doc.save();
    } catch (err) {
      failed++;
      if (err.response?.status === 429) break; // quota — stop the batch, keep the rest un-stamped
    }
  }
  const remaining = await Dispensary.countDocuments(filter);
  return { attempted: docs.length, enriched, noMatch, failed, remaining };
}

module.exports = { enrichBatch };
