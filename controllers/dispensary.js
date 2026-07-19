// controllers/dispensary.js
//
// HTTP surface for the nationwide dispensary database (models/Dispensary.js).
// The Field Map reads bbox slices of OUR collection (instant + free) instead
// of live-querying Google per pan; Google is now only (a) per-store
// enrichment and (b) the optional "sweep this area" diff for brand-new
// stores. Every pin carries a CRM cross-reference so the map knows which
// stores are already leads/customers.

const Dispensary = require('../models/Dispensary');
const Client = require('../models/Client');
const DispensaryDenylist = require('../models/DispensaryDenylist');
const OsmScanTile = require('../models/OsmScanTile');
const { REC_STATES, MEDICAL_ONLY, NO_RETAIL_YET, deriveSegment, SEGMENTS } = require('../services/dispensaryStates');
const { ingestState, rechainState, geocodeMissing, deriveCompanyKey, matchKey, upsertOsmCandidates } = require('../services/dispensaryIngest');
const { enrichBatch } = require('../services/dispensaryEnrich');
const { detectKnownChain } = require('../services/dispensaryChains');
const { fetchDispensariesForBbox } = require('../services/dispensaryFinder');

function parseBbox(q) {
  const minLat = parseFloat(q.minLat), maxLat = parseFloat(q.maxLat);
  const minLng = parseFloat(q.minLng), maxLng = parseFloat(q.maxLng);
  if (![minLat, maxLat, minLng, maxLng].every(isFinite)) return null;
  return { minLat, maxLat, minLng, maxLng };
}

// ── Free OSM viewport scan — pure helpers (unit-tested) ──────────────────────
const OSM_TILE_DEG = 0.5;        // tile grid: ~35mi squares
const OSM_MAX_SPAN_DEG = 2.0;    // only scan when zoomed in past ~this span
const OSM_TILE_TTL_MS = 30 * 24 * 3600 * 1000;  // re-sweep a tile monthly
const OSM_MATCH_PAD = 0.02;      // ~2km — same storefront cross-source match
const OSM_SCAN_TIMEOUT_MS = 25_000;  // interactive: don't hang on a slow endpoint

// The grid tile CONTAINING (lat,lng), as a stable string key. Snapped to the
// tile's SW corner at fixed precision so float noise can't split one tile in two.
function tileKeyFor(lat, lng, tileDeg = OSM_TILE_DEG) {
  const snap = (v) => Math.floor(v / tileDeg) * tileDeg;
  return `${snap(lat).toFixed(2)}_${snap(lng).toFixed(2)}`;
}

// Is the viewport too wide to sweep? (A whole-region bbox would pull thousands
// of elements and hammer Overpass — we only scan once the user is zoomed in.)
function bboxTooLarge(bbox, maxSpan = OSM_MAX_SPAN_DEG) {
  return (bbox.maxLat - bbox.minLat) > maxSpan || (bbox.maxLng - bbox.minLng) > maxSpan;
}

// Best-effort 2-letter state from an assembled "..., City ST 07102" address
// (osmAddress emits "City ST zip" with no comma before the state) — the trailing
// 2-letter token, with or without a following ZIP. 'US' when nothing parses
// (state is a required Dispensary field, mostly for the coverage rollup). Pure.
function stateFromAddress(addr) {
  const m = String(addr || '').match(/\b([A-Z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?\s*$/);
  return (m && m[1]) || 'US';
}

// ── GET /api/roadtrip/dispensaries?minLat&maxLat&minLng&maxLng[&segments=..] ─
// Returns every active, visible INDEPENDENT dispensary in the viewport plus
// its CRM stage (if the company exists in the CRM). Chains are excluded at
// the source — the owner doesn't pitch them, so they never render (owner
// decision; chain detection itself stays, the dedupe machinery uses it).
// `segments` is a CSV of rec|med|hemp (default: all three); rows whose
// segment can't be derived ('' — unparsed state) are never filtered out.
// Capped defensively — a whole-US zoom is served, just thinned to the cap.
async function listDispensaries(req, res) {
  try {
    const bbox = parseBbox(req.query);
    if (!bbox) return res.status(400).json({ message: 'minLat/maxLat/minLng/maxLng are required.' });
    const filter = {
      active: true, hidden: false,
      isChain: { $ne: true },
      lat: { $gte: bbox.minLat, $lte: bbox.maxLat },
      lng: { $gte: bbox.minLng, $lte: bbox.maxLng },
    };
    if (req.query.verifiedOnly === 'true') filter.verified = true;

    // Segment filter — DB-side for stamped rows (so a narrow selection in a
    // dense, capped viewport doesn't lose pins to post-cap thinning), with
    // un-stamped legacy rows ('' / missing) still fetched, derived from
    // state+source, and pruned in memory.
    const wanted = String(req.query.segments || '')
      .split(',').map((s) => s.trim()).filter((s) => SEGMENTS.includes(s));
    const narrowed = wanted.length > 0 && wanted.length < SEGMENTS.length;
    if (narrowed) {
      filter.$or = [
        { segment: { $in: wanted } },
        { segment: { $in: ['', null] } },
        { segment: { $exists: false } },
      ];
    }

    const cap = 4000;
    let docs = await Dispensary.find(filter).limit(cap).lean();
    const capped = docs.length >= cap;

    for (const d of docs) d.segment = d.segment || deriveSegment(d.state, d.source);
    if (narrowed) {
      docs = docs.filter((d) => !d.segment || wanted.includes(d.segment));
    }

    // CRM cross-reference in one indexed query: match by companyKey OR the
    // fuzzier matchKey (same derivations the CRM itself uses).
    const companyKeys = [...new Set(docs.map((d) => d.companyKey).filter(Boolean))];
    const matchKeys = [...new Set(docs.map((d) => d.matchKey).filter(Boolean))];
    // Include ARCHIVED matches too. If we hid them, the map showed crm:null for an
    // archived company, the client sent stage:'lead', and the touch/to-do landed
    // on the hidden archived record — a silent dead-end (and a stage regression).
    // Surfacing the match (with `archived`) lets the map show it AND the capture
    // path unarchive it instead of writing blind.
    const clients = companyKeys.length || matchKeys.length
      ? await Client.find(
          { $or: [{ companyKey: { $in: companyKeys } }, { matchKey: { $in: matchKeys } }] },
          { companyKey: 1, matchKey: 1, stage: 1, nextFollowUp: 1, archived: 1 }
        ).lean()
      : [];
    const byCompanyKey = new Map();
    const byMatchKey = new Map();
    for (const c of clients) {
      if (c.companyKey) byCompanyKey.set(c.companyKey, c);
      if (c.matchKey) byMatchKey.set(c.matchKey, c);
    }

    const results = docs.map((d) => {
      const crmClient = byCompanyKey.get(d.companyKey) || byMatchKey.get(d.matchKey) || null;
      return {
        _id: d._id,
        state: d.state,
        name: d.name,
        licensee: d.licensee,
        licenseNumber: d.licenseNumber,
        address: [d.address, d.city].filter(Boolean).join(', ') + (d.zip ? ` ${d.zip}` : ''),
        lat: d.lat, lng: d.lng,
        phone: d.phone, website: d.website,
        placeId: d.placeId, googleMapsUri: d.googleMapsUri,
        rating: d.rating, ratingCount: d.ratingCount,
        businessStatus: d.businessStatus,
        segment: d.segment,
        verified: d.verified, source: d.source,
        enriched: !!d.enrichedAt,
        lastVisitedAt: d.lastVisitedAt,
        companyKey: d.companyKey,
        crm: crmClient ? { companyKey: crmClient.companyKey, stage: crmClient.stage } : null,
      };
    });

    res.json({ count: results.length, capped, results });
  } catch (err) {
    console.error('[dispensary] list error:', err.message);
    res.status(500).json({ message: 'Dispensary lookup failed.' });
  }
}

// ── POST /api/roadtrip/dispensaries/corridor ─────────────────────────────────
// The corridor day planner's scan: given a driving route's polyline (the
// frontend gets it from Mapbox Directions — from where I am, through the towns
// I pass, to where I'm sleeping) and a half-width in miles, return every
// independent dispensary inside that band, ordered by where along the drive it
// falls. One indexed whole-route bbox prefilter (the scalar {lat,lng} compound
// index — no geo index exists), then an in-memory point-to-polyline prune so a
// diagonal route's fat rectangle doesn't drown the list in off-corridor pins.

const CORRIDOR_MAX_POINTS = 600;   // decimated polyline the frontend sends
const CORRIDOR_MAX_MI = 12;        // widest allowed half-width

// Prune docs to within bufferMi of the polyline, stamping each survivor with
// its perpendicular distance and its progress (0..1) along the drive. Local
// equirectangular frame in miles — plenty accurate at corridor scale. PURE
// (exported for tests).
function corridorPrune(points, docs, bufferMi) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const midLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const kx = 69 * Math.cos((midLat * Math.PI) / 180);
  const ky = 69;
  const P = points.map((p) => ({ x: p.lng * kx, y: p.lat * ky }));
  const cum = [0];
  for (let i = 1; i < P.length; i += 1) {
    cum.push(cum[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y));
  }
  const total = cum[cum.length - 1] || 1;
  const out = [];
  for (const d of docs) {
    const qx = d.lng * kx, qy = d.lat * ky;
    let best = Infinity, bestT = 0;
    for (let i = 1; i < P.length; i += 1) {
      const ax = P[i - 1].x, ay = P[i - 1].y;
      const dx = P[i].x - ax, dy = P[i].y - ay;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((qx - ax) * dx + (qy - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = ax + t * dx, py = ay + t * dy;
      const dist = Math.hypot(qx - px, qy - py);
      if (dist < best) {
        best = dist;
        bestT = (cum[i - 1] + t * (cum[i] - cum[i - 1])) / total;
      }
    }
    if (best <= bufferMi) out.push({ doc: d, distanceMi: Math.round(best * 10) / 10, progress: bestT });
  }
  out.sort((a, b) => a.progress - b.progress);
  return out;
}

async function corridor(req, res) {
  try {
    const body = req.body || {};
    const raw = Array.isArray(body.points) ? body.points : [];
    const points = raw
      .map((p) => ({ lat: parseFloat(p && p.lat), lng: parseFloat(p && p.lng) }))
      .filter((p) => isFinite(p.lat) && isFinite(p.lng))
      .slice(0, CORRIDOR_MAX_POINTS);
    if (points.length < 2) return res.status(400).json({ message: 'points (the route polyline) are required.' });
    const bufferMi = Math.max(1, Math.min(CORRIDOR_MAX_MI, parseFloat(body.bufferMi) || 3));

    // Whole-route bbox, padded by the corridor half-width (deg ≈ mi/69; lng
    // scaled by cos(midLat)) — one indexed range query, then the real prune.
    const midLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const latPad = bufferMi / 69;
    const lngPad = bufferMi / (69 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
    const filter = {
      active: true, hidden: false,
      isChain: { $ne: true },
      lat: { $gte: Math.min(...points.map((p) => p.lat)) - latPad, $lte: Math.max(...points.map((p) => p.lat)) + latPad },
      lng: { $gte: Math.min(...points.map((p) => p.lng)) - lngPad, $lte: Math.max(...points.map((p) => p.lng)) + lngPad },
    };
    const cap = 4000;
    const docs = await Dispensary.find(filter).limit(cap).lean();
    for (const d of docs) d.segment = d.segment || deriveSegment(d.state, d.source);

    const pruned = corridorPrune(points, docs, bufferMi);

    // Same CRM join the viewport list uses, so corridor rows carry the stage.
    const companyKeys = [...new Set(pruned.map(({ doc: d }) => d.companyKey).filter(Boolean))];
    const matchKeys = [...new Set(pruned.map(({ doc: d }) => d.matchKey).filter(Boolean))];
    const clients = companyKeys.length || matchKeys.length
      ? await Client.find(
          { $or: [{ companyKey: { $in: companyKeys } }, { matchKey: { $in: matchKeys } }] },
          { companyKey: 1, matchKey: 1, stage: 1 }
        ).lean()
      : [];
    const byCompanyKey = new Map();
    const byMatchKey = new Map();
    for (const c of clients) {
      if (c.companyKey) byCompanyKey.set(c.companyKey, c);
      if (c.matchKey) byMatchKey.set(c.matchKey, c);
    }

    const results = pruned.map(({ doc: d, distanceMi, progress }) => {
      const crmClient = byCompanyKey.get(d.companyKey) || byMatchKey.get(d.matchKey) || null;
      return {
        _id: d._id,
        name: d.name,
        address: [d.address, d.city].filter(Boolean).join(', ') + (d.zip ? ` ${d.zip}` : ''),
        lat: d.lat, lng: d.lng,
        phone: d.phone,
        segment: d.segment,
        verified: d.verified,
        lastVisitedAt: d.lastVisitedAt,
        companyKey: d.companyKey,
        crm: crmClient ? { companyKey: crmClient.companyKey, stage: crmClient.stage } : null,
        distanceMi, progress,
      };
    });

    res.json({ count: results.length, capped: docs.length >= cap, bufferMi, results });
  } catch (err) {
    console.error('[dispensary] corridor error:', err.message);
    res.status(500).json({ message: 'Corridor scan failed.' });
  }
}

// ── GET /api/roadtrip/dispensaries/coverage ──────────────────────────────────
// Per-state ingest/enrichment status for the coverage panel: which of the 24
// rec states have data, how fresh, how enriched — plus the medical-only list
// the map dims.
async function coverage(_req, res) {
  try {
    const agg = await Dispensary.aggregate([
      { $match: { hidden: false } },
      {
        $group: {
          _id: '$state',
          total: { $sum: { $cond: ['$active', 1, 0] } },
          verified: { $sum: { $cond: [{ $and: ['$active', '$verified'] }, 1, 0] } },
          enriched: { $sum: { $cond: [{ $and: ['$active', { $ne: ['$enrichedAt', null] }] }, 1, 0] } },
          mapped: { $sum: { $cond: [{ $and: ['$active', { $ne: ['$lat', null] }] }, 1, 0] } },
          chains: { $addToSet: '$chainName' },
          lastVerifiedAt: { $max: '$lastVerifiedAt' },
        },
      },
    ]);
    const byState = new Map(agg.map((a) => [a._id, a]));
    const states = Object.entries(REC_STATES).map(([code, cfg]) => {
      const a = byState.get(code);
      return {
        code,
        name: cfg.name,
        approxRetail: cfg.approxRetail,
        rosterKind: cfg.roster.kind,
        rosterHomepage: cfg.roster.homepage || '',
        total: a?.total || 0,
        verified: a?.verified || 0,
        enriched: a?.enriched || 0,
        mapped: a?.mapped || 0,
        chainCount: a ? a.chains.filter(Boolean).length : 0,
        lastVerifiedAt: a?.lastVerifiedAt || null,
      };
    });
    res.json({ states, medicalOnly: MEDICAL_ONLY, noRetailYet: NO_RETAIL_YET });
  } catch (err) {
    console.error('[dispensary] coverage error:', err.message);
    res.status(500).json({ message: 'Coverage lookup failed.' });
  }
}

// ── POST /api/roadtrip/dispensaries/ingest/:state ────────────────────────────
async function ingest(req, res) {
  try {
    const state = String(req.params.state || '').toUpperCase();
    const report = await ingestState(state, {
      sourceUrlOverride: req.body?.sourceUrlOverride || null,
    });
    res.json(report);
  } catch (err) {
    console.error('[dispensary] ingest error:', err.message);
    res.status(err.statusCode || 500).json({ message: err.message, attempts: err.attempts || null });
  }
}

// ── POST /api/roadtrip/dispensaries/enrich  {bbox?, state?, limit?} ─────────
async function enrich(req, res) {
  try {
    const out = await enrichBatch({
      bbox: req.body?.bbox || null,
      state: req.body?.state || null,
      limit: parseInt(req.body?.limit, 10) || 15,
    });
    res.json(out);
  } catch (err) {
    console.error('[dispensary] enrich error:', err.response?.data || err.message);
    res.status(err.statusCode || 500).json({ message: err.message });
  }
}

// ── POST /api/roadtrip/dispensaries/geocode {state} ─────────────────────────
async function geocode(req, res) {
  try {
    const state = String(req.body?.state || '').toUpperCase();
    if (!state) return res.status(400).json({ message: 'state is required.' });
    res.json(await geocodeMissing(state, { limit: parseInt(req.body?.limit, 10) || 300 }));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── POST /api/roadtrip/dispensaries/sweep {lat,lng,radius} ───────────────────
// Live Google sweep around a point, diffed against the DB. New finds insert
// as source:'google', verified:false — the "unverified" pins. This is how a
// brand-new store (or a state with no roster adapter) gets onto the map.
async function sweep(req, res) {
  try {
    const lat = parseFloat(req.body?.lat), lng = parseFloat(req.body?.lng);
    if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ message: 'lat and lng are required.' });
    const radius = Math.min(parseInt(req.body?.radius, 10) || 20000, 50000);

    const { runDispensaryTextScan } = require('./placeSearch');
    const found = await runDispensaryTextScan({ lat, lng, radius });

    const placeIds = found.map((p) => p.externalId).filter(Boolean);
    const existing = await Dispensary.find(
      { $or: [{ placeId: { $in: placeIds } }] },
      { placeId: 1 }
    ).lean();
    const knownPlaceIds = new Set(existing.map((d) => d.placeId));

    // Name+proximity match against roster rows that just aren't enriched yet,
    // so a sweep doesn't duplicate a licensed store under a Google identity.
    const pad = 0.02; // ~2km — pins for the same storefront geocode this close
    let added = 0, matched = 0, attached = 0;
    for (const p of found) {
      if (!p.externalId) continue;
      if (knownPlaceIds.has(p.externalId)) { matched++; continue; }
      const near = await Dispensary.findOne({
        active: true,
        matchKey: matchKey(p.name),
        lat: { $gte: p.lat - pad, $lte: p.lat + pad },
        lng: { $gte: p.lng - pad, $lte: p.lng + pad },
      });
      if (near) {
        // Same store, roster identity — attach the Google details.
        near.placeId = near.placeId || p.externalId;
        near.phone = near.phone || p.phone;
        near.website = near.website || p.website;
        near.googleMapsUri = near.googleMapsUri || p.extras?.googleMapsUri || '';
        near.rating = near.rating ?? p.rating;
        near.enrichedAt = near.enrichedAt || new Date();
        await near.save();
        attached++;
        continue;
      }
      const stateGuess = (String(p.address).match(/,\s*([A-Z]{2})\s+\d{5}/) || [])[1] || '';
      await Dispensary.updateOne(
        { dedupeKey: `${stateGuess || 'US'}|place:${p.externalId}` },
        {
          $set: {
            state: stateGuess || 'US',
            name: p.name,
            address: p.address,
            lat: p.lat, lng: p.lng,
            phone: p.phone, website: p.website,
            placeId: p.externalId,
            googleMapsUri: p.extras?.googleMapsUri || '',
            rating: p.rating, ratingCount: p.extras?.ratingCount ?? null,
            source: 'google', verified: false, active: true,
            segment: deriveSegment(stateGuess, 'google'),
            isChain: !!detectKnownChain(p.name), chainName: detectKnownChain(p.name) || '',
            companyKey: deriveCompanyKey(p.name),
            matchKey: matchKey(p.name),
            enrichedAt: new Date(),
          },
        },
        { upsert: true }
      );
      added++;
    }
    res.json({ scanned: found.length, added, matchedExisting: matched, attachedToRoster: attached });
  } catch (err) {
    console.error('[dispensary] sweep error:', err.response?.data || err.message);
    res.status(err.statusCode || 500).json({ message: err.message || 'Sweep failed.' });
  }
}

// ── POST /api/roadtrip/dispensaries/:id/hide ─────────────────────────────────
// "Not a dispensary" — hides the row AND denylists its placeId so the live
// sweep can never re-import it.
async function hide(req, res) {
  try {
    const doc = await Dispensary.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Not found.' });
    doc.hidden = true;
    await doc.save();
    if (doc.placeId) {
      await DispensaryDenylist.updateOne(
        { placeId: doc.placeId },
        { $set: { placeId: doc.placeId, name: doc.name, reason: 'not a real dispensary' } },
        { upsert: true }
      );
    }
    res.json({ hidden: true, _id: doc._id });
  } catch (err) {
    res.status(500).json({ message: 'Hide failed.' });
  }
}

// ── POST /api/roadtrip/dispensaries/rechain ──────────────────────────────────
async function rechain(req, res) {
  try {
    res.json(await rechainState(req.body?.state ? String(req.body.state).toUpperCase() : null));
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

// ── POST /api/roadtrip/dispensaries/scan-osm {minLat,maxLat,minLng,maxLng} ───
// FREE dispensary discovery as the Field Map is panned. Queries OpenStreetMap
// (Overpass — no API key, no billing) for the viewport, upserts finds into our
// own Dispensary DB (source:'osm', unverified), and cross-matches so a store we
// already know isn't duplicated. Tile-throttled: each ~0.5° tile hits Overpass
// at most once every 30 days; panning a worked area is served from the DB. This
// replaces the paid Google "sweep" and the per-state manual roster loading —
// dispensaries just appear as you drive the map, at zero cost.
async function scanOsm(req, res) {
  try {
    const bbox = parseBbox(req.body || {}) || parseBbox(req.query || {});
    if (!bbox) return res.status(400).json({ message: 'minLat/maxLat/minLng/maxLng are required.' });
    if (bboxTooLarge(bbox)) return res.json({ skipped: 'too-wide', added: 0, attached: 0 });

    const centerLat = (bbox.minLat + bbox.maxLat) / 2;
    const centerLng = (bbox.minLng + bbox.maxLng) / 2;
    const tileKey = tileKeyFor(centerLat, centerLng);

    // Tile throttle — recently swept → serve from the DB, don't re-hit Overpass.
    const prior = await OsmScanTile.findOne({ tileKey }).lean();
    if (prior && (Date.now() - new Date(prior.scannedAt).getTime()) < OSM_TILE_TTL_MS) {
      return res.json({ cached: true, added: 0, attached: 0, tileKey });
    }

    // Overpass bbox order is [south, west, north, east].
    const candidates = await fetchDispensariesForBbox(
      [bbox.minLat, bbox.minLng, bbox.maxLat, bbox.maxLng],
      { timeoutMs: OSM_SCAN_TIMEOUT_MS },
    );

    // Persist every find via the shared roster upsert (same helper the always-on
    // finder now uses, so a scan and an auto-sweep write pins identically).
    const { added, attached } = await upsertOsmCandidates(candidates);

    await OsmScanTile.updateOne(
      { tileKey },
      { $set: { tileKey, scannedAt: new Date(), found: candidates.length, imported: added } },
      { upsert: true },
    );

    res.json({ added, attached, found: candidates.length, tileKey });
  } catch (err) {
    console.error('[dispensary] scanOsm error:', err.message);
    // Soft failure: the map already shows its DB pins. A flaky Overpass endpoint
    // must never surface as a red error to someone prospecting in the field.
    res.status(200).json({ added: 0, attached: 0, error: 'osm-scan-unavailable' });
  }
}

module.exports = {
  listDispensaries, coverage, ingest, enrich, geocode, sweep, hide, rechain, scanOsm, corridor,
  // pure — unit-tested
  tileKeyFor, bboxTooLarge, stateFromAddress, corridorPrune,
};
