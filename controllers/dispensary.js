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
const { ROSTER_STATES, MEDICAL_ONLY, NO_RETAIL_YET, deriveSegment, SEGMENTS } = require('../services/dispensaryStates');
const { ingestState, rechainState, geocodeMissing, deriveCompanyKey, matchKey, upsertOsmCandidates } = require('../services/dispensaryIngest');
const { enrichBatch } = require('../services/dispensaryEnrich');
const { detectKnownChain } = require('../services/dispensaryChains');
const { fetchDispensariesForBbox, fetchDispensariesForBboxes, REGIONS } = require('../services/dispensaryFinder');
const { fieldMap: FIELD_MAP_VERTICAL } = require('../services/leadVerticals');
const { ensureStateRoster } = require('../services/rosterAutopilot');

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

// EVERY grid tile a bbox touches (not just its center's). The old center-only
// key was the silent-coverage bug: a scan of an up-to-2° viewport recorded ONE
// 0.5° tile, so panning inside a "scanned" tile skipped virgin fringe ground
// for 30 days. Bookkeeping is now per-tile over the whole box. Pure.
function tilesForBbox(bbox, tileDeg = OSM_TILE_DEG) {
  const snap = (v) => Math.floor(v / tileDeg) * tileDeg;
  const out = [];
  // Epsilon keeps a bbox edge sitting exactly on a grid line from claiming the
  // next (untouched) tile row/column.
  const eps = 1e-9;
  for (let lat = snap(bbox.minLat); lat < bbox.maxLat - eps; lat += tileDeg) {
    for (let lng = snap(bbox.minLng); lng < bbox.maxLng - eps; lng += tileDeg) {
      out.push({
        key: `${lat.toFixed(2)}_${lng.toFixed(2)}`,
        minLat: lat, minLng: lng,
        maxLat: lat + tileDeg, maxLng: lng + tileDeg,
      });
    }
  }
  return out;
}

// The single bbox covering a set of tiles (their union extent). Pure.
function tilesExtent(tiles) {
  return {
    minLat: Math.min(...tiles.map((t) => t.minLat)),
    maxLat: Math.max(...tiles.map((t) => t.maxLat)),
    minLng: Math.min(...tiles.map((t) => t.minLng)),
    maxLng: Math.max(...tiles.map((t) => t.maxLng)),
  };
}

// Which STATE is the viewport looking at? Resolved from the lead finder's
// per-state region bboxes: the SMALLEST region box containing the viewport
// center wins (boxes bleed over borders by design; the smallest container is
// the state actually under the cursor in practice). '' when nothing contains
// the point (ocean, Canada). Drives the on-demand roster seeding — hovering
// Cleveland with zero OH roster rows kicks the OH license ingest right then.
// Pure (exported for tests).
function stateForViewportCenter(bbox, regions = REGIONS) {
  const lat = (bbox.minLat + bbox.maxLat) / 2;
  const lng = (bbox.minLng + bbox.maxLng) / 2;
  let best = '';
  let bestArea = Infinity;
  for (const [id, region] of Object.entries(regions || {})) {
    const [s, w, n, e] = region.bbox || [];
    if (!(lat >= s && lat <= n && lng >= w && lng <= e)) continue;
    const area = (n - s) * (e - w);
    if (area < bestArea) { bestArea = area; best = id.toUpperCase(); }
  }
  return best;
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
// Returns every active, visible dispensary in the viewport plus its CRM stage
// (if the company exists in the CRM). Chains (MSOs) are excluded by DEFAULT —
// the owner mostly pitches independents — but `chains=true` includes them (the
// map's CHAINS clicker): in MSO-dominated markets (PA med) hiding them hides
// most of the map, so nothing is ever silently missing — the response always
// carries `chainCount` for the "+N chains" hint even when they're excluded.
// `segments` is a CSV of rec|med|hemp (default: all three); rows whose
// segment can't be derived ('' — unparsed state) are never filtered out.
// Capped defensively — a whole-US zoom is served, just thinned to the cap.
async function listDispensaries(req, res) {
  try {
    const bbox = parseBbox(req.query);
    if (!bbox) return res.status(400).json({ message: 'minLat/maxLat/minLng/maxLng are required.' });
    const includeChains = req.query.chains === 'true';
    const geoFilter = {
      active: true, hidden: false,
      lat: { $gte: bbox.minLat, $lte: bbox.maxLat },
      lng: { $gte: bbox.minLng, $lte: bbox.maxLng },
    };
    const filter = { ...geoFilter };
    if (!includeChains) filter.isChain = { $ne: true };
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

    // Always tell the map how many chain stores sit in this viewport, so the
    // CHAINS clicker can show "+N" instead of hiding an MSO market silently.
    const chainCount = await Dispensary.countDocuments({ ...geoFilter, isChain: true });

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
        isChain: !!d.isChain, chainName: d.chainName || '',
        companyKey: d.companyKey,
        crm: crmClient ? { companyKey: crmClient.companyKey, stage: crmClient.stage } : null,
      };
    });

    res.json({ count: results.length, capped, chainCount, results });
  } catch (err) {
    console.error('[dispensary] list error:', err.message);
    res.status(500).json({ message: 'Dispensary lookup failed.' });
  }
}

// ── GET /api/roadtrip/dispensaries/find?q= ───────────────────────────────────
// Name/city search over the dispensary DB — the search box's missing half.
// The NAVIGATE box only ever geocoded ("philadelphia" flew the camera and
// nothing searched dispensaries); this lets a typed name/city hit actual
// stores. Case-insensitive substring, verified/roster rows first, capped small
// for typeahead.
async function findDispensaries(req, res) {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json({ results: [] });
    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(esc, 'i');
    const docs = await Dispensary.find({
      active: true, hidden: false,
      lat: { $ne: null }, lng: { $ne: null },
      $or: [{ name: rx }, { city: rx }],
    })
      .sort({ verified: -1, name: 1 })
      .limit(30)
      .lean();
    // Independents first within the small result page, chains still findable.
    docs.sort((a, b) => (a.isChain === b.isChain ? 0 : a.isChain ? 1 : -1));
    const results = docs.slice(0, 8).map((d) => ({
      _id: d._id,
      name: d.name,
      address: [d.address, d.city].filter(Boolean).join(', ') + (d.zip ? ` ${d.zip}` : ''),
      state: d.state,
      lat: d.lat, lng: d.lng,
      segment: d.segment || deriveSegment(d.state, d.source),
      verified: d.verified,
      isChain: !!d.isChain,
    }));
    res.json({ results });
  } catch (err) {
    console.error('[dispensary] find error:', err.message);
    res.status(500).json({ message: 'Dispensary search failed.' });
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
const CORRIDOR_CHUNKS = 8;         // route pieces for the one-shot live fill
const CORRIDOR_FILL_TIMEOUT_MS = 20_000; // interactive budget for the fill

// Chop the route into ~equal chunks and pad each chunk's bbox by the corridor
// half-width (+1mi slack) — the multi-bbox Overpass fill queries all of them
// in ONE round trip, so a 300-mile drive through never-scanned country gets
// live discovery without per-tile latency. Pure (exported for tests).
function corridorChunks(points, bufferMi, chunks = CORRIDOR_CHUNKS) {
  if (!Array.isArray(points) || points.length < 2) return [];
  const per = Math.max(2, Math.ceil(points.length / chunks));
  const midLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const latPad = (bufferMi + 1) / 69;
  const lngPad = (bufferMi + 1) / (69 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  const out = [];
  for (let i = 0; i < points.length - 1; i += per) {
    // Overlap by one point so a store sitting exactly on a chunk seam is
    // inside at least one box.
    const slice = points.slice(i, Math.min(points.length, i + per + 1));
    if (slice.length < 2) continue;
    const lats = slice.map((p) => p.lat);
    const lngs = slice.map((p) => p.lng);
    // Overpass bbox order: [south, west, north, east].
    out.push([
      Math.min(...lats) - latPad,
      Math.min(...lngs) - lngPad,
      Math.max(...lats) + latPad,
      Math.max(...lngs) + lngPad,
    ]);
  }
  return out;
}

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
    const includeChains = body.chains === true || body.chains === 'true';

    // ROSTER SEEDING ALONG THE ROUTE: a cross-country plan (Voorhees → CO)
    // crosses states whose license rosters may have never loaded — kick the
    // ingest for each unseeded roster state the route touches, so re-scanning
    // in a couple of minutes shows the licensed stores too. Sampled sparsely;
    // ensureStateRoster's own guards make repeats free.
    const seedingStates = [];
    try {
      const step = Math.max(1, Math.floor(points.length / 30));
      const routeStates = [...new Set(points.filter((_, i) => i % step === 0)
        .map((p) => stateForViewportCenter({ minLat: p.lat, maxLat: p.lat, minLng: p.lng, maxLng: p.lng }))
        .filter(Boolean))];
      for (const st of routeStates) {
        // eslint-disable-next-line no-await-in-loop
        const rows = await Dispensary.countDocuments({ state: st, source: 'roster' }).catch(() => 1);
        if (rows === 0) {
          ensureStateRoster(st, { reason: 'corridor' }); // deliberately not awaited
          seedingStates.push(st);
        }
      }
    } catch { /* seeding is a bonus — never fail the scan over it */ }

    // LIVE FILL: the old corridor read only the DB, so a drive through
    // never-scanned country returned near-nothing (the Voorhees → Clarion
    // 7-stop bug). Unless the caller opts out (fill:false), sweep the whole
    // route band in ONE multi-bbox Overpass query (free, keyless) and upsert
    // the finds before pruning. Best-effort: a slow/down Overpass just means
    // DB-only results, flagged so the UI can say so.
    let fill = { attempted: false, found: 0, added: 0, failed: false };
    if (body.fill !== false) {
      fill.attempted = true;
      try {
        const chunks = corridorChunks(points, bufferMi);
        const candidates = await fetchDispensariesForBboxes(chunks, {
          vertical: FIELD_MAP_VERTICAL,
          timeoutMs: CORRIDOR_FILL_TIMEOUT_MS,
        });
        const { added } = await upsertOsmCandidates(candidates);
        fill.found = candidates.length;
        fill.added = added;
      } catch (e) {
        fill.failed = true;
        console.warn('[dispensary] corridor fill unavailable:', e.message);
      }
    }

    // Whole-route bbox, padded by the corridor half-width (deg ≈ mi/69; lng
    // scaled by cos(midLat)) — one indexed range query, then the real prune.
    const midLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
    const latPad = bufferMi / 69;
    const lngPad = bufferMi / (69 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
    const filter = {
      active: true, hidden: false,
      lat: { $gte: Math.min(...points.map((p) => p.lat)) - latPad, $lte: Math.max(...points.map((p) => p.lat)) + latPad },
      lng: { $gte: Math.min(...points.map((p) => p.lng)) - lngPad, $lte: Math.max(...points.map((p) => p.lng)) + lngPad },
    };
    if (!includeChains) filter.isChain = { $ne: true };
    const cap = 4000;
    const docs = await Dispensary.find(filter).limit(cap).lean();
    for (const d of docs) d.segment = d.segment || deriveSegment(d.state, d.source);

    // Honor the map's audience clickers (rec/med/hemp) — the corridor used to
    // ignore them, which is how hemp/kratom-net junk rode along on every plan.
    const wanted = String(body.segments || '')
      .split(',').map((s) => s.trim()).filter((s) => SEGMENTS.includes(s));
    const narrowed = wanted.length > 0 && wanted.length < SEGMENTS.length;
    const audienceDocs = narrowed
      ? docs.filter((d) => !d.segment || wanted.includes(d.segment))
      : docs;

    const pruned = corridorPrune(points, audienceDocs, bufferMi);

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
        isChain: !!d.isChain, chainName: d.chainName || '',
        companyKey: d.companyKey,
        crm: crmClient ? { companyKey: crmClient.companyKey, stage: crmClient.stage } : null,
        distanceMi, progress,
      };
    });

    res.json({ count: results.length, capped: docs.length >= cap, bufferMi, fill, seedingStates, results });
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
    // Rec AND med roster states — the coverage view is "everywhere pitchable",
    // not just the adult-use map (PA's absence here is how its emptiness went
    // unnoticed for months).
    const states = Object.entries(ROSTER_STATES).map(([code, cfg]) => {
      const a = byState.get(code);
      return {
        code,
        name: cfg.name,
        market: MEDICAL_ONLY.includes(code) ? 'med' : 'rec',
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

    // ON-DEMAND ROSTER SEEDING: if the state under the viewport has NO license
    // roster loaded (Cleveland with zero OH rows), kick its ingest right now in
    // the background — the owner is literally looking at the hole. The response
    // carries `seeding` so the map can say so and refresh in a minute. The
    // autopilot's own guards (in-flight, failure cooldown, roster-less states)
    // make the fire-and-forget safe to repeat on every pan.
    let seeding = null;
    const viewState = stateForViewportCenter(bbox);
    if (viewState) {
      const rosterRows = await Dispensary.countDocuments({ state: viewState, source: 'roster' }).catch(() => 1);
      if (rosterRows === 0) {
        ensureStateRoster(viewState, { reason: 'viewport' }); // deliberately not awaited
        seeding = viewState;
      }
    }

    // Per-tile throttle over EVERY tile the viewport touches (the old
    // center-tile-only key silently skipped virgin fringe ground for 30 days).
    const tiles = tilesForBbox(bbox);
    const cutoff = new Date(Date.now() - OSM_TILE_TTL_MS);
    const fresh = await OsmScanTile.find({
      tileKey: { $in: tiles.map((t) => t.key) },
      scannedAt: { $gte: cutoff },
    }).select('tileKey').lean();
    const freshKeys = new Set(fresh.map((t) => t.tileKey));
    const stale = tiles.filter((t) => !freshKeys.has(t.key));
    if (!stale.length) {
      return res.json({ cached: true, added: 0, attached: 0, seeding, tiles: { total: tiles.length, scanned: 0 } });
    }

    // One Overpass query over the stale tiles' union extent (≤ the snapped
    // viewport, so still bounded), with the combined rec+medical net — a med-
    // only state's licensed dispensaries are pitchable and belong on the map.
    const extent = tilesExtent(stale);
    const candidates = await fetchDispensariesForBbox(
      [extent.minLat, extent.minLng, extent.maxLat, extent.maxLng],
      { timeoutMs: OSM_SCAN_TIMEOUT_MS, vertical: FIELD_MAP_VERTICAL },
    );

    // Persist every find via the shared roster upsert (same helper the always-on
    // finder now uses, so a scan and an auto-sweep write pins identically).
    const { added, attached } = await upsertOsmCandidates(candidates);

    const now = new Date();
    await OsmScanTile.bulkWrite(stale.map((t) => ({
      updateOne: {
        filter: { tileKey: t.key },
        update: { $set: { tileKey: t.key, scannedAt: now, found: candidates.length, imported: added } },
        upsert: true,
      },
    })), { ordered: false });

    res.json({ added, attached, found: candidates.length, seeding, tiles: { total: tiles.length, scanned: stale.length } });
  } catch (err) {
    console.error('[dispensary] scanOsm error:', err.message);
    // Soft failure: the map already shows its DB pins. A flaky Overpass endpoint
    // must never surface as a red error to someone prospecting in the field.
    res.status(200).json({ added: 0, attached: 0, error: 'osm-scan-unavailable' });
  }
}

module.exports = {
  listDispensaries, findDispensaries, coverage, ingest, enrich, geocode, sweep, hide, rechain, scanOsm, corridor,
  // pure — unit-tested
  tileKeyFor, tilesForBbox, tilesExtent, bboxTooLarge, stateFromAddress, corridorPrune, corridorChunks,
  stateForViewportCenter,
};
