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
const { REC_STATES, MEDICAL_ONLY, NO_RETAIL_YET } = require('../services/dispensaryStates');
const { ingestState, rechainState, geocodeMissing, deriveCompanyKey, matchKey } = require('../services/dispensaryIngest');
const { enrichBatch } = require('../services/dispensaryEnrich');
const { detectKnownChain } = require('../services/dispensaryChains');

function parseBbox(q) {
  const minLat = parseFloat(q.minLat), maxLat = parseFloat(q.maxLat);
  const minLng = parseFloat(q.minLng), maxLng = parseFloat(q.maxLng);
  if (![minLat, maxLat, minLng, maxLng].every(isFinite)) return null;
  return { minLat, maxLat, minLng, maxLng };
}

// ── GET /api/roadtrip/dispensaries?minLat&maxLat&minLng&maxLng[&chain=..] ────
// Returns every active, visible dispensary in the viewport plus its CRM
// stage (if the company exists in the CRM). Capped defensively — a whole-US
// zoom is served, just thinned to the cap.
async function listDispensaries(req, res) {
  try {
    const bbox = parseBbox(req.query);
    if (!bbox) return res.status(400).json({ message: 'minLat/maxLat/minLng/maxLng are required.' });
    const filter = {
      active: true, hidden: false,
      lat: { $gte: bbox.minLat, $lte: bbox.maxLat },
      lng: { $gte: bbox.minLng, $lte: bbox.maxLng },
    };
    if (req.query.chain) filter.chainName = req.query.chain;
    if (req.query.verifiedOnly === 'true') filter.verified = true;

    const cap = 4000;
    const docs = await Dispensary.find(filter).limit(cap).lean();

    // CRM cross-reference in one indexed query: match by companyKey OR the
    // fuzzier matchKey (same derivations the CRM itself uses).
    const companyKeys = [...new Set(docs.map((d) => d.companyKey).filter(Boolean))];
    const matchKeys = [...new Set(docs.map((d) => d.matchKey).filter(Boolean))];
    const clients = companyKeys.length || matchKeys.length
      ? await Client.find(
          { archived: { $ne: true }, $or: [{ companyKey: { $in: companyKeys } }, { matchKey: { $in: matchKeys } }] },
          { companyKey: 1, matchKey: 1, stage: 1, nextFollowUp: 1 }
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
        isChain: d.isChain, chainName: d.chainName,
        verified: d.verified, source: d.source,
        enriched: !!d.enrichedAt,
        lastVisitedAt: d.lastVisitedAt,
        companyKey: d.companyKey,
        crm: crmClient ? { companyKey: crmClient.companyKey, stage: crmClient.stage } : null,
      };
    });

    // Chain rollup for the CHAINS panel: name → store count in view.
    const chainCounts = {};
    for (const r of results) {
      if (r.chainName) chainCounts[r.chainName] = (chainCounts[r.chainName] || 0) + 1;
    }

    res.json({ count: results.length, capped: docs.length >= cap, results, chains: chainCounts });
  } catch (err) {
    console.error('[dispensary] list error:', err.message);
    res.status(500).json({ message: 'Dispensary lookup failed.' });
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

module.exports = { listDispensaries, coverage, ingest, enrich, geocode, sweep, hide, rechain };
