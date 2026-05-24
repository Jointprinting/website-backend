// controllers/roadTripRoute.js
//
// Two endpoints that power the "GO TONIGHT" routing and "VALIDATE AREA"
// tools on the frontend:
//
//   POST /api/roadtrip/density/area    — count dispensaries near a point,
//                                        suggest denser nearby alternatives.
//                                        Caches results 7 days to keep
//                                        Google Places usage trivial.
//
//   POST /api/roadtrip/corridor/leads  — given a from→to pair, return saved
//                                        leads inside the corridor with
//                                        their progress along the path.
//                                        Pure DB query + geometry; zero
//                                        external API calls.
//
//   GET    /api/roadtrip/density/cache         — admin debug list
//   DELETE /api/roadtrip/density/cache/:cellKey — clear a single cell
//
// Geometry is equirectangular (flat-earth projection). For trip-scale
// corridors (<800 mi) this is indistinguishable from great-circle math in
// practice and avoids the trig in the hot path.

const axios = require('axios');
const RoadTripLead = require('../models/RoadTripLead');
const DispensaryDensityCache = require('../models/DispensaryDensityCache');

// ─────────────────────────────────────────────────────────────────────────────
// Geometry helpers (mirrors _roadTripGeo.js on the frontend)
// ─────────────────────────────────────────────────────────────────────────────

const R_M = 6_371_000;
const M_PER_MI = 1609.344;

function toEquirect(latDeg, lngDeg, refLatDeg) {
  const lat = (latDeg * Math.PI) / 180;
  const lng = (lngDeg * Math.PI) / 180;
  const refLat = (refLatDeg * Math.PI) / 180;
  return { x: R_M * lng * Math.cos(refLat), y: R_M * lat };
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_M * Math.asin(Math.sqrt(a));
}

/** Project point P onto the line A→B; return progress [0..1] + cross-track miles. */
function corridorProject(A, B, P) {
  const refLat = (A.lat + B.lat) / 2;
  const a = toEquirect(A.lat, A.lng, refLat);
  const b = toEquirect(B.lat, B.lng, refLat);
  const p = toEquirect(P.lat, P.lng, refLat);
  const abx = b.x - a.x, aby = b.y - a.y;
  const apx = p.x - a.x, apy = p.y - a.y;
  const abLen2 = abx * abx + aby * aby;
  if (abLen2 === 0) return { progress: 0, crossTrackMi: 0 };
  const t = (apx * abx + apy * aby) / abLen2;
  const closestX = a.x + t * abx, closestY = a.y + t * aby;
  const dx = p.x - closestX, dy = p.y - closestY;
  const crossM = Math.sqrt(dx * dx + dy * dy);
  return { progress: t, crossTrackMi: crossM / M_PER_MI };
}

// ─────────────────────────────────────────────────────────────────────────────
// Density cache helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Snap lat/lng to a 0.05° grid (~3.5 mi at 40°N). */
function snap(v) {
  return Math.round(v / 0.05) * 0.05;
}

function radiusBucketLabel(radiusM) {
  const mi = radiusM / M_PER_MI;
  if (mi <= 7) return '5mi';
  if (mi <= 14) return '10mi';
  return '20mi';
}

function makeCellKey(lat, lng, radiusM) {
  return `lat:${snap(lat).toFixed(2)}|lng:${snap(lng).toFixed(2)}|r:${radiusBucketLabel(radiusM)}`;
}

function countWithin(center, points, radiusMi) {
  const radiusM = radiusMi * M_PER_MI;
  let n = 0;
  for (const p of points) {
    if (!isFinite(p.lat) || !isFinite(p.lng)) continue;
    if (haversineMeters(center.lat, center.lng, p.lat, p.lng) <= radiusM) n++;
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/roadtrip/density/area
// ─────────────────────────────────────────────────────────────────────────────

async function densityArea(req, res) {
  try {
    const lat = parseFloat(req.body.lat);
    const lng = parseFloat(req.body.lng);
    if (!isFinite(lat) || !isFinite(lng)) {
      return res.status(400).json({ message: 'lat and lng are required.' });
    }
    const scanRadiusM    = Math.min(parseInt(req.body.scanRadiusM, 10)    || 32187, 50000); // 20mi default, 50km cap
    const densityRadiusM = Math.min(parseInt(req.body.densityRadiusM, 10) || 8047,  scanRadiusM); // 5mi default
    const fresh = req.body.fresh === true || req.body.fresh === 'true';

    const cellKey = makeCellKey(lat, lng, scanRadiusM);
    let cacheDoc = fresh ? null : await DispensaryDensityCache.findOne({ cellKey }).lean();
    let cached = !!cacheDoc;

    if (!cacheDoc) {
      // Cache miss — call Google. Lazy-require placeSearch so circular imports
      // (placeSearch already exports many things) stay safe.
      const { runDispensaryTextScan } = require('./placeSearch');
      const results = await runDispensaryTextScan({ lat, lng, radius: scanRadiusM });
      const countWithinR = countWithin({ lat, lng }, results, densityRadiusM / M_PER_MI);
      cacheDoc = await DispensaryDensityCache.findOneAndUpdate(
        { cellKey },
        {
          $set: {
            cellKey,
            centerLat: lat,
            centerLng: lng,
            radiusM: scanRadiusM,
            results,
            count: results.length,
            countWithinRadius: countWithinR,
            fetchedAt: new Date(),
            expiresAt: new Date(Date.now() + DispensaryDensityCache.SEVEN_DAYS_MS),
          },
        },
        { upsert: true, new: true }
      ).lean();
      cached = false;
    }

    // Re-derive count within the (possibly smaller) requested density radius.
    // This is free — same result set, just a different radius slice.
    const densityRadiusMi = densityRadiusM / M_PER_MI;
    const densityCount = countWithin({ lat, lng }, cacheDoc.results, densityRadiusMi);

    // Sample 5 results inside the density radius for the modal preview.
    const sample = cacheDoc.results
      .filter((p) => haversineMeters(lat, lng, p.lat, p.lng) <= densityRadiusM)
      .slice(0, 5)
      .map((p) => ({ name: p.name, lat: p.lat, lng: p.lng }));

    // Alternative spots: cluster cached results on a ~3mi grid, count
    // dispensaries within 5mi of each centroid, keep clusters more than 4mi
    // from `center` that are 1.25× denser. Reverse-geocode top 3 via Mapbox.
    const alternatives = await findDenserAlternatives({
      center: { lat, lng },
      points: cacheDoc.results,
      centerCount: densityCount,
      scanRadiusM,
    });

    res.json({
      center: { lat, lng },
      density: { radiusM: densityRadiusM, count: densityCount, sample },
      alternatives,
      cached,
      fetchedAt: cacheDoc.fetchedAt,
    });
  } catch (err) {
    console.error('[roadTripRoute] densityArea error:', err.response?.data || err.message);
    res.status(err.statusCode || 500).json({
      message: err.message || 'Density lookup failed.',
      detail: err.response?.data || null,
    });
  }
}

/**
 * Cluster cached results into 3mi grid buckets; return centroids that are
 * (a) at least 4mi from the original center, (b) at least 1.25× denser than
 * the center. Reverse-geocodes top 3 via Mapbox.
 */
async function findDenserAlternatives({ center, points, centerCount, scanRadiusM }) {
  const cellMi = 3; // 3mi grid for clustering
  const buckets = new Map();
  for (const p of points) {
    if (!isFinite(p.lat) || !isFinite(p.lng)) continue;
    const distFromCenterMi = haversineMeters(center.lat, center.lng, p.lat, p.lng) / M_PER_MI;
    if (distFromCenterMi < 4) continue; // too close to original
    if (distFromCenterMi * M_PER_MI > scanRadiusM) continue; // outside scan
    const key = `${Math.round(p.lat / (cellMi / 69))}|${Math.round(p.lng / (cellMi / 55))}`;
    const b = buckets.get(key) || { lat: 0, lng: 0, n: 0 };
    b.lat += p.lat; b.lng += p.lng; b.n += 1;
    buckets.set(key, b);
  }

  // Centroid of each bucket; count dispensaries within 5mi of each centroid.
  const candidates = [];
  for (const b of buckets.values()) {
    const lat = b.lat / b.n;
    const lng = b.lng / b.n;
    const countWithin5mi = countWithin({ lat, lng }, points, 5);
    if (countWithin5mi >= Math.max(centerCount * 1.25, centerCount + 3)) {
      candidates.push({
        lat, lng, countWithin5mi,
        distanceMi: haversineMeters(center.lat, center.lng, lat, lng) / M_PER_MI,
      });
    }
  }
  candidates.sort((a, b) => b.countWithin5mi - a.countWithin5mi);
  const top = candidates.slice(0, 3);

  // Reverse-geocode each top alternative for a city label. Mapbox token
  // comes from env. If geocoding fails, fall back to a compass-direction
  // string.
  await Promise.all(top.map(async (c) => {
    c.label = await reverseGeocodeLabel(c.lat, c.lng)
              || compassLabel(center, c);
  }));

  return top;
}

async function reverseGeocodeLabel(lat, lng) {
  const token = process.env.MAPBOX_TOKEN || process.env.REACT_APP_MAPBOX_TOKEN;
  if (!token) return null;
  try {
    const { data } = await axios.get(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json`,
      { params: { access_token: token, types: 'place,locality,neighborhood', limit: 1 },
        timeout: 8_000 }
    );
    const feat = (data.features || [])[0];
    return feat?.text || feat?.place_name || null;
  } catch {
    return null;
  }
}

function compassLabel(from, to) {
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;
  const ns = dLat > 0.02 ? 'N' : dLat < -0.02 ? 'S' : '';
  const ew = dLng > 0.02 ? 'E' : dLng < -0.02 ? 'W' : '';
  return `denser spot ${ns}${ew || ''}`.trim() || 'denser spot nearby';
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/roadtrip/corridor/leads
// ─────────────────────────────────────────────────────────────────────────────

async function corridorLeads(req, res) {
  try {
    const from = req.body.from || {};
    const to   = req.body.to   || {};
    const fLat = parseFloat(from.lat), fLng = parseFloat(from.lng);
    const tLat = parseFloat(to.lat),   tLng = parseFloat(to.lng);
    if (!isFinite(fLat) || !isFinite(fLng) || !isFinite(tLat) || !isFinite(tLng)) {
      return res.status(400).json({ message: 'from {lat,lng} and to {lat,lng} are required.' });
    }
    const corridorMi = Math.max(1, parseFloat(req.body.corridorMi) || 8);
    const types = Array.isArray(req.body.types) && req.body.types.length
      ? req.body.types
      : ['dispensary'];

    const filter = { type: { $in: types } };
    if (req.body.tripLabel) filter.tripLabel = req.body.tripLabel;

    // Bounding-box pre-filter to limit how many leads we project. The box is
    // the rectangle around (from, to) expanded by ~corridorMi on each side.
    // 1 deg lat ≈ 69mi; 1 deg lng ≈ 55mi at 40°N (good enough as a buffer).
    const pad = corridorMi / 60; // generous — we re-filter exactly below
    filter.lat = { $gte: Math.min(fLat, tLat) - pad, $lte: Math.max(fLat, tLat) + pad };
    filter.lng = { $gte: Math.min(fLng, tLng) - pad, $lte: Math.max(fLng, tLng) + pad };

    const leads = await RoadTripLead.find(filter).lean();
    const A = { lat: fLat, lng: fLng };
    const B = { lat: tLat, lng: tLng };

    const inCorridor = [];
    for (const lead of leads) {
      if (!isFinite(lead.lat) || !isFinite(lead.lng)) continue;
      const { progress, crossTrackMi } = corridorProject(A, B, lead);
      if (crossTrackMi > corridorMi) continue;
      if (progress < 0 || progress > 1) continue;
      inCorridor.push({
        ...lead,
        progress,
        crossTrackMi,
        detourMi: crossTrackMi * 2,
      });
    }
    inCorridor.sort((a, b) => a.progress - b.progress);

    res.json({ count: inCorridor.length, leads: inCorridor });
  } catch (err) {
    console.error('[roadTripRoute] corridorLeads error:', err);
    res.status(500).json({ message: 'Corridor lookup failed.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache management (admin debug)
// ─────────────────────────────────────────────────────────────────────────────

async function listDensityCache(_req, res) {
  try {
    const entries = await DispensaryDensityCache.find({}, {
      cellKey: 1, centerLat: 1, centerLng: 1, radiusM: 1,
      count: 1, countWithinRadius: 1, fetchedAt: 1, expiresAt: 1,
    }).sort({ fetchedAt: -1 }).limit(200).lean();
    res.json({ count: entries.length, entries });
  } catch (err) {
    res.status(500).json({ message: 'Failed to list density cache.' });
  }
}

async function clearDensityCacheEntry(req, res) {
  try {
    await DispensaryDensityCache.deleteOne({ cellKey: req.params.cellKey });
    res.json({ deleted: true, cellKey: req.params.cellKey });
  } catch (err) {
    res.status(500).json({ message: 'Failed to clear cache entry.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/roadtrip/corridor/scan
//
// "Intelligent" pitch — when the user opens the PITCH planner and the
// corridor of saved leads is sparse, this auto-scans Google along the
// route to surface dispensaries the user hasn't pinned yet.
//
// Strategy: walk the from→to line in ~6mi chunks, run the dispensary text
// search at each sample point, dedupe by externalId, project each result
// onto the corridor (cross-track + progress), drop anything more than
// `corridorMi` off-line, return sorted by progress.
//
// Heavily cached: every sample point hits the same DispensaryDensityCache
// rows used by /density/area. A typical day's corridor reuses cache cells
// from prior validations and from previous days' scans, so steady-state
// cost is ~1-2 Google calls per never-before-seen day.
// ─────────────────────────────────────────────────────────────────────────────

async function corridorScan(req, res) {
  try {
    const from = req.body.from || {};
    const to   = req.body.to   || {};
    const fLat = parseFloat(from.lat), fLng = parseFloat(from.lng);
    const tLat = parseFloat(to.lat),   tLng = parseFloat(to.lng);
    if (!isFinite(fLat) || !isFinite(fLng) || !isFinite(tLat) || !isFinite(tLng)) {
      return res.status(400).json({ message: 'from {lat,lng} and to {lat,lng} are required.' });
    }
    const corridorMi   = Math.max(1, parseFloat(req.body.corridorMi)   || 8);
    const sampleSpacingMi = Math.max(3, parseFloat(req.body.spacingMi) || 6);

    const A = { lat: fLat, lng: fLng };
    const B = { lat: tLat, lng: tLng };
    const totalMi = haversineMeters(A.lat, A.lng, B.lat, B.lng) / M_PER_MI;
    if (totalMi < 0.5) {
      return res.json({ count: 0, leads: [], googleCalls: 0, cachedCalls: 0 });
    }
    const nSamples = Math.min(8, Math.max(2, Math.ceil(totalMi / sampleSpacingMi)));

    // 5mi radius scans (smaller than validate's 20mi) — bounded cost; the
    // overlap from adjacent samples covers any gaps.
    const scanRadiusM = 8047;

    const { runDispensaryTextScan } = require('./placeSearch');
    const seen = new Map();
    let googleCalls = 0;
    let cachedCalls = 0;

    for (let i = 0; i < nSamples; i++) {
      const t = nSamples === 1 ? 0.5 : i / (nSamples - 1);
      const lat = A.lat + (B.lat - A.lat) * t;
      const lng = A.lng + (B.lng - A.lng) * t;
      const cellKey = makeCellKey(lat, lng, scanRadiusM);

      let results;
      const cached = await DispensaryDensityCache.findOne({ cellKey }).lean();
      if (cached) {
        results = cached.results;
        cachedCalls++;
      } else {
        results = await runDispensaryTextScan({ lat, lng, radius: scanRadiusM });
        googleCalls++;
        await DispensaryDensityCache.findOneAndUpdate(
          { cellKey },
          {
            $set: {
              cellKey, centerLat: lat, centerLng: lng, radiusM: scanRadiusM,
              results, count: results.length,
              countWithinRadius: results.length,
              fetchedAt: new Date(),
              expiresAt: new Date(Date.now() + DispensaryDensityCache.SEVEN_DAYS_MS),
            },
          },
          { upsert: true, new: true }
        );
      }
      for (const p of results) {
        if (!p.externalId || seen.has(p.externalId)) continue;
        seen.set(p.externalId, p);
      }
    }

    // Project all candidates onto the A→B line; keep ones inside the corridor.
    const inCorridor = [];
    for (const p of seen.values()) {
      if (!isFinite(p.lat) || !isFinite(p.lng)) continue;
      const { progress, crossTrackMi } = corridorProject(A, B, p);
      if (crossTrackMi > corridorMi) continue;
      if (progress < 0 || progress > 1) continue;
      inCorridor.push({ ...p, progress, crossTrackMi, detourMi: crossTrackMi * 2 });
    }
    inCorridor.sort((a, b) => a.progress - b.progress);

    res.json({
      count: inCorridor.length,
      leads: inCorridor,
      googleCalls, cachedCalls,
      message: googleCalls === 0
        ? 'All scans served from cache (free).'
        : `${googleCalls} fresh Google call(s); ${cachedCalls} cached.`,
    });
  } catch (err) {
    console.error('[roadTripRoute] corridorScan error:', err.response?.data || err.message);
    res.status(err.statusCode || 500).json({
      message: err.message || 'Corridor scan failed.',
      detail: err.response?.data || null,
    });
  }
}

module.exports = {
  densityArea,
  corridorLeads,
  corridorScan,
  listDensityCache,
  clearDensityCacheEntry,
};
