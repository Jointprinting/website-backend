// services/dispensaryIngest.js
//
// Pulls a state's dispensary roster (see services/dispensaryStates.js for
// per-state sources), normalizes it, and upserts into the Dispensary
// collection. Design goals, in order:
//
//   1. NEVER trust a fixed schema. State portals rename columns without
//      notice, and the Cannlytics aggregate varies by state. Headers are
//      matched by keyword scoring (sniffHeaders) and the ingest report lists
//      what mapped where, so drift is visible instead of silent.
//   2. Degrade, don't fail. primary source → cannlytics fallback → clear
//      report saying "seed this state from the Google sweep instead".
//   3. Idempotent. dedupeKey = state+licenseNumber (or address fallback);
//      re-ingesting refreshes rows and stamps lastVerifiedAt; rows the fresh
//      roster no longer contains get active:false (never deleted).
//
// Geocoding: rosters carry addresses, not always coordinates. Missing coords
// are geocoded through Mapbox (effectively free at our volume) right after
// ingest so every store is mappable immediately; Google enrichment
// (services/dispensaryEnrich.js) later refines coords + adds contact fields.

const axios = require('axios');
const { StringDecoder } = require('string_decoder');
const Dispensary = require('../models/Dispensary');
const { ROSTER_STATES, MED_STATES, deriveSegment } = require('./dispensaryStates');
const { assignChains, detectKnownChain } = require('./dispensaryChains');

// Same normalizations the CRM uses — keep byte-for-byte in sync with
// utils/fieldTrackerImport.js (deriveCompanyKey / matchKey).
function deriveCompanyKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
const CORP_SUFFIXES = ['incorporated', 'corporation', 'company', 'limited',
  'inc', 'llc', 'l.l.c', 'co', 'corp', 'ltd', 'lp', 'llp', 'plc'];
function matchKey(name) {
  let raw = String(name || '').toLowerCase();
  raw = raw.replace(/['’`]/g, '');
  for (const suf of CORP_SUFFIXES) {
    const re = new RegExp(`[\\s,.&-]+${suf.replace(/\./g, '\\.')}\\.?$`, 'i');
    if (re.test(raw)) { raw = raw.replace(re, ''); break; }
  }
  return raw.replace(/[^a-z0-9]+/g, '');
}

// ── CSV parsing (RFC-4180-ish, no dependency) ────────────────────────────────

/** Parse CSV text → array of objects keyed by header row. Handles quoted
 *  fields, escaped quotes, and CRLF/LF. */
function parseCsv(text) {
  const rows = [];
  let field = '', row = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { rows.push(row); row = []; };
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\n') { pushField(); pushRow(); }
    else if (c === '\r') { /* swallow; \n handles the row */ }
    else field += c;
  }
  if (field !== '' || row.length) { pushField(); pushRow(); }
  while (rows.length && rows[rows.length - 1].every((v) => v === '')) rows.pop();
  if (!rows.length) return [];
  const headers = rows[0].map((h) => String(h || '').trim());
  return rows.slice(1).map((r) => {
    const o = {};
    headers.forEach((h, i) => { if (h) o[h] = r[i] !== undefined ? r[i] : ''; });
    return o;
  });
}

/** Incremental flavor of parseCsv: feed text chunks with push(), each completed
 *  row (array of fields) fires onRow. The whole-country aggregate is ~100MB —
 *  parseCsv on that materializes every US license as objects and OOM-kills a
 *  small dyno, so the aggregate path streams through this instead. An escaped
 *  quote ("") or closing quote split across a chunk boundary is carried via
 *  pendingQuote. */
function csvStreamParser(onRow) {
  let field = '', row = [], inQuotes = false, pendingQuote = false;
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); onRow(row); row = []; };
  return {
    push(chunk) {
      const s = String(chunk);
      let i = 0;
      if (pendingQuote && s.length) {
        pendingQuote = false;
        if (s[0] === '"') { field += '"'; i = 1; }   // "" pair straddled the boundary
        else inQuotes = false;                        // it was the closing quote
      }
      for (; i < s.length; i++) {
        const c = s[i];
        if (inQuotes) {
          if (c === '"') {
            if (i + 1 >= s.length) pendingQuote = true;      // decide on next chunk
            else if (s[i + 1] === '"') { field += '"'; i++; }
            else inQuotes = false;
          } else field += c;
        } else if (c === '"') inQuotes = true;
        else if (c === ',') endField();
        else if (c === '\n') endRow();
        else if (c !== '\r') field += c;
      }
    },
    flush() {
      if (pendingQuote) { pendingQuote = false; inQuotes = false; }  // trailing " closes
      if (field !== '' || row.length) endRow();
    },
  };
}

// ── Header sniffing ──────────────────────────────────────────────────────────
//
// For each logical field, an ordered list of scoring rules: [mustMatch,
// bonus]. The header with the highest score wins; ties go to the earlier
// rule. Headers are compared lowercased with non-alphanumerics squashed.

const norm = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');

const FIELD_RULES = {
  state:         [/premise_state|^state$|state_?code|license_state/],
  name:          [/dba|doing_business_as/, /trade_name/, /business_name/, /^(business_legal_)?name$/, /retailer/, /establishment/, /entity_name/, /license_holder/, /^premise_name/, /name/],
  licensee:      [/legal_name/, /licensee/, /license_holder/, /owner/, /entity_name/, /parent/],
  licenseNumber: [/license_(no|number|num)/, /^license$/, /credential/, /^lic_/, /permit/, /license/],
  licenseType:   [/license_type/, /_type$/, /class/, /category/, /^type/],
  licenseStatus: [/status/],
  address:       [/street.*address|address.*(line)?_?1|premise_address|physical_address/, /^address$/, /location/, /address/],
  city:          [/city|town|municipality/],
  zip:           [/zip|postal/],
  county:        [/county/],
  lat:           [/^lat(itude)?$|premise_lat/, /lat/],
  lng:           [/^(lng|lon|long|longitude)$|premise_long/, /lon|lng/],
  phone:         [/phone|tel/],
  website:       [/website|web_?site|url/],
};

/** Map logical fields → actual header names present in `headers`. */
function sniffHeaders(headers) {
  const map = {};
  const normed = headers.map((h) => ({ raw: h, n: norm(h) }));
  for (const [field, rules] of Object.entries(FIELD_RULES)) {
    outer:
    for (const rule of rules) {
      for (const h of normed) {
        if (rule.test(h.n)) { map[field] = h.raw; break outer; }
      }
    }
  }
  return map;
}

// ── Row filtering + normalization ────────────────────────────────────────────

// A roster row must look like a RETAIL location for its market. States vary:
// some rosters are retail-only (CT), some carry every license class (NY).
// If a type column exists we require retail-ish, and exclude clearly
// non-retail classes. Market rules differ:
//   • adult-use states: medical-only license types are excluded unless
//     dual-use (a rec pitch wants rec shelves);
//   • medical-only states (MED_STATES): the medical dispensary/treatment-
//     center/pharmacy types ARE the market — they must pass, not be filtered
//     (this exclusion was exactly why PA could never roster-load).
const RETAILISH = /retail|dispensar|store(front)?|microbusiness|hybrid/i;
const MED_RETAILISH = /retail|dispensar|store(front)?|pharmacy|treatment[\s-]*center|mmtc/i;
const NON_RETAIL = /cultivat|grow|process|manufactur|transport|distribut|lab(oratory)?|testing|delivery[\s-]*only|wholesal|nursery|event|consumption|research/i;
const MEDICAL_ONLY_TYPE = /^med(ical)?[\s-]*(marijuana|cannabis)?[\s-]*(dispensary|treatment|only)?$/i;
const DEAD_STATUS = /inactive|expired|revoked|surrender|cancel|denied|withdraw|closed|terminated/i;

function rowPasses(row, map, typeFilter, { medicalMarket = false } = {}) {
  const type = map.licenseType ? String(row[map.licenseType] || '') : '';
  const status = map.licenseStatus ? String(row[map.licenseStatus] || '') : '';
  if (status && DEAD_STATUS.test(status)) return false;
  if (typeFilter) return typeFilter.test(type);
  if (type) {
    const retailish = medicalMarket ? MED_RETAILISH : RETAILISH;
    if (NON_RETAIL.test(type) && !retailish.test(type)) return false;
    if (!medicalMarket && MEDICAL_ONLY_TYPE.test(type.trim())) return false;
    if (!retailish.test(type)) return false;
  }
  return true;
}

function normalizeRow(row, map, state, sourceUrl) {
  const get = (f) => (map[f] ? String(row[map[f]] ?? '').trim() : '');
  const name = get('name') || get('licensee');
  if (!name) return null;
  const licenseNumber = get('licenseNumber');
  const address = get('address');
  const city = get('city');
  const lat = parseFloat(get('lat'));
  const lng = parseFloat(get('lng'));
  const dedupeKey = licenseNumber
    ? `${state}|lic:${licenseNumber.toLowerCase()}`
    : `${state}|addr:${deriveCompanyKey(name)}|${deriveCompanyKey(address + city)}`;
  return {
    state,
    name,
    licensee: get('licensee'),
    licenseNumber,
    licenseType: get('licenseType'),
    licenseStatus: get('licenseStatus'),
    address,
    city,
    zip: get('zip'),
    phone: get('phone'),
    website: get('website'),
    lat: isFinite(lat) ? lat : null,
    lng: isFinite(lng) ? lng : null,
    source: 'roster',
    verified: true,
    active: true,
    segment: deriveSegment(state, 'roster'),
    dedupeKey,
    rosterSource: sourceUrl,
    companyKey: deriveCompanyKey(name),
    matchKey: matchKey(name),
  };
}

// ── Fetching ─────────────────────────────────────────────────────────────────

// The ordered source attempts for one state's roster. Every state ends with
// the cannlytics ALL-STATES aggregate — one file that carries every licensed
// state — so a moved/missing per-state CSV (the Ohio failure) degrades to
// "same data, bigger download" instead of an empty state. Pure (exported for
// tests).
function rosterAttempts(cfg, state, sourceUrlOverride = null) {
  if (sourceUrlOverride) {
    return [{ kind: /\.json/.test(sourceUrlOverride) ? 'socrata' : 'csv', url: sourceUrlOverride }];
  }
  const attempts = [];
  if (cfg.roster.kind !== 'google') attempts.push({ kind: cfg.roster.kind, url: cfg.roster.url });
  // Cannlytics per-state fallback for states whose primary is something else.
  if (cfg.roster.kind === 'socrata' || cfg.roster.kind === 'csv') {
    attempts.push({
      kind: 'cannlytics',
      url: `https://huggingface.co/datasets/cannlytics/cannabis_licenses/resolve/main/data/${state.toLowerCase()}/licenses-${state.toLowerCase()}-latest.csv`,
    });
  }
  // Aggregate-of-last-resort (rows filtered to the state at ingest time).
  attempts.push({
    kind: 'cannlytics-all',
    url: 'https://huggingface.co/datasets/cannlytics/cannabis_licenses/resolve/main/data/all/licenses-all-latest.csv',
  });
  return attempts;
}

// The aggregate CSV carries every state's licenses. Streaming it and keeping
// only the target state's rows bounds peak memory to one chunk + one row +
// that state's rows (a few hundred), instead of the whole country — buffering
// it whole is what OOM-crashed the API host (Render exit 134). A file whose
// header has no recognizable state column is refused outright: without it we
// can't filter, and importing the whole country under one state is worse than
// importing nothing (same stance as rowMatchesState).
const AGGREGATE_MAX_BYTES = 120 * 1024 * 1024;
const AGGREGATE_MAX_ROWS = 25_000;   // a whole state's licenses is ~1–2k; this is "schema went sideways"

function collectAggregateRowsForState(stream, state, stateName, { maxBytes = AGGREGATE_MAX_BYTES, maxRows = AGGREGATE_MAX_ROWS, idleMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const stateU = String(state).toUpperCase();
    const nameU = String(stateName || '').toUpperCase();
    const decoder = new StringDecoder('utf8');
    let bytes = 0, headers = null, stateIdx = -1, done = false, idleTimer = null;
    const kept = [];
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer);
      try { if (typeof stream.destroy === 'function') stream.destroy(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(val);
    };
    // A stalled body must not hang this promise: downloads are serialized
    // process-wide, so a wedged stream here would block every future
    // aggregate fetch until reboot.
    const armIdle = () => {
      if (!idleMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish(new Error(`aggregate stream stalled (no data for ${idleMs}ms)`)), idleMs);
    };
    armIdle();
    const parser = csvStreamParser((row) => {
      if (done) return;
      if (!headers) {
        headers = row.map((h) => String(h || '').trim());
        const map = sniffHeaders(headers);
        stateIdx = map.state ? headers.indexOf(map.state) : -1;
        if (stateIdx < 0) finish(new Error('aggregate has no state column — refusing to import unfiltered'));
        return;
      }
      const v = String(row[stateIdx] || '').trim().toUpperCase();
      if (v !== stateU && (!nameU || v !== nameU)) return;
      const o = {};
      headers.forEach((h, i) => { if (h) o[h] = row[i] !== undefined ? row[i] : ''; });
      kept.push(o);
      if (kept.length > maxRows) finish(new Error(`aggregate matched >${maxRows} rows for ${state} — refusing`));
    });
    stream.on('data', (chunk) => {
      if (done) return;
      armIdle();
      bytes += chunk.length;
      if (bytes > maxBytes) return finish(new Error(`aggregate exceeded ${Math.round(maxBytes / 1e6)}MB`));
      try { parser.push(decoder.write(chunk)); } catch (e) { finish(e); }
    });
    stream.on('end', () => {
      if (done) return;
      try { parser.push(decoder.end()); parser.flush(); } catch (e) { return finish(e); }
      finish(null, kept);
    });
    stream.on('error', (e) => finish(e));
  });
}

// One aggregate download at a time, process-wide: the autopilot loads up to 3
// states per tick and viewport/corridor seeding can fire concurrently — two
// parallel ~100MB streams is how you meet the OOM killer twice.
let aggregateChain = Promise.resolve();
function fetchAggregateRowsForState(state, stateName, url) {
  const run = () => axios
    .get(url, { timeout: 120_000, responseType: 'stream' })
    .then((res) => collectAggregateRowsForState(res.data, state, stateName));
  const p = aggregateChain.then(run, run);
  aggregateChain = p.catch(() => {});
  return p;
}

async function fetchRoster(state, { sourceUrlOverride } = {}) {
  const cfg = ROSTER_STATES[state];
  if (!cfg) throw Object.assign(new Error(`No roster source configured for "${state}".`), { statusCode: 400 });
  const attempts = rosterAttempts(cfg, state, sourceUrlOverride);
  const errors = [];
  for (const att of attempts) {
    try {
      let rows;
      if (att.kind === 'cannlytics-all') {
        rows = await fetchAggregateRowsForState(state, cfg.name, att.url);
      } else {
        const { data } = await axios.get(att.url, {
          timeout: 60_000,
          responseType: att.kind === 'socrata' ? 'json' : 'text',
          maxContentLength: 50 * 1024 * 1024,
        });
        rows = att.kind === 'socrata' ? (Array.isArray(data) ? data : []) : parseCsv(data);
      }
      if (rows.length) return { rows, sourceUrl: att.url, sourceKind: att.kind, errors };
      errors.push(`${att.kind}: 0 rows from ${att.url}`);
    } catch (err) {
      errors.push(`${att.kind}: ${err.message}`);
    }
  }
  const e = new Error(`No roster source worked for ${state}. Tried: ${errors.join(' | ')}. Seed this state with the Google sweep instead.`);
  e.statusCode = 502;
  e.attempts = errors;
  throw e;
}

// Does an all-states aggregate row belong to `state`? Matched on the sniffed
// state column against the 2-letter code or the state's full name; a row with
// NO state column never matches (better to import nothing than the whole
// country under one state). Pure (exported for tests).
function rowMatchesState(row, map, state, stateName = '') {
  if (!map.state) return false;
  const v = String(row[map.state] || '').trim().toUpperCase();
  if (!v) return false;
  return v === String(state).toUpperCase() || v === String(stateName).toUpperCase();
}

// ── Mapbox geocoding for rows missing coordinates ────────────────────────────

async function geocodeMissing(state, { limit = 300 } = {}) {
  const token = process.env.MAPBOX_TOKEN || process.env.REACT_APP_MAPBOX_TOKEN;
  if (!token) return { geocoded: 0, skipped: 0, message: 'MAPBOX_TOKEN not set — skipped geocoding.' };
  const docs = await Dispensary.find({
    state, active: true, hidden: false,
    $or: [{ lat: null }, { lng: null }],
    address: { $ne: '' },
  }).limit(limit);
  let geocoded = 0, failed = 0;
  for (const doc of docs) {
    try {
      const q = encodeURIComponent(`${doc.address}, ${doc.city} ${doc.state} ${doc.zip}`.trim());
      const { data } = await axios.get(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${q}.json`,
        { params: { access_token: token, limit: 1, country: 'US' }, timeout: 10_000 }
      );
      const feat = (data.features || [])[0];
      if (feat && Array.isArray(feat.center)) {
        doc.lng = feat.center[0];
        doc.lat = feat.center[1];
        await doc.save();
        geocoded++;
      } else failed++;
    } catch { failed++; }
  }
  return { geocoded, failed, remaining: Math.max(0, docs.length === limit ? 1 : 0) };
}

// ── Chain pass over one state (or all) ───────────────────────────────────────

async function rechainState(state) {
  const filter = { active: true, hidden: false };
  if (state) filter.state = state;
  const docs = await Dispensary.find(filter, { name: 1, licensee: 1 }).lean();
  const chainMap = assignChains(docs.map((d) => ({ name: d.name, licensee: d.licensee })));
  const ops = [];
  docs.forEach((d, i) => {
    const chainName = chainMap.get(i) || '';
    ops.push({
      updateOne: {
        filter: { _id: d._id },
        update: { $set: { chainName, isChain: !!chainName } },
      },
    });
  });
  if (ops.length) await Dispensary.bulkWrite(ops, { ordered: false });
  return { checked: docs.length, chains: [...new Set([...chainMap.values()])].length };
}

// ── Main entry: ingest one state ─────────────────────────────────────────────

async function ingestState(state, opts = {}) {
  const startedAt = new Date();
  const { rows, sourceUrl, sourceKind, errors } = await fetchRoster(state, opts);
  const cfg = ROSTER_STATES[state];
  const medicalMarket = !!MED_STATES[state];

  const headers = Object.keys(rows[0] || {});
  const map = sniffHeaders(headers);
  const typeFilter = cfg.roster.typeFilter || null;

  const normalized = [];
  let filtered = 0;
  for (const row of rows) {
    // The all-states aggregate carries every state's licenses — keep only ours.
    if (sourceKind === 'cannlytics-all' && !rowMatchesState(row, map, state, cfg.name)) { filtered++; continue; }
    if (!rowPasses(row, map, typeFilter, { medicalMarket })) { filtered++; continue; }
    const n = normalizeRow(row, map, state, sourceUrl);
    if (n) normalized.push(n);
  }

  // Dedupe within the batch (rosters sometimes repeat a license per endorsement)
  const byKey = new Map();
  for (const n of normalized) byKey.set(n.dedupeKey, n);
  const unique = [...byKey.values()];

  let created = 0, updated = 0;
  const seenKeys = [];
  for (const n of unique) {
    seenKeys.push(n.dedupeKey);
    // Preserve enrichment + coords on refresh: only set roster-owned fields.
    const res = await Dispensary.updateOne(
      { dedupeKey: n.dedupeKey },
      {
        $set: {
          state: n.state, name: n.name, licensee: n.licensee,
          licenseNumber: n.licenseNumber, licenseType: n.licenseType,
          licenseStatus: n.licenseStatus,
          address: n.address, city: n.city, zip: n.zip,
          source: 'roster', verified: true, active: true,
          segment: n.segment,
          rosterSource: n.rosterSource, lastVerifiedAt: startedAt,
          companyKey: n.companyKey, matchKey: n.matchKey,
          ...(n.phone ? { phone: n.phone } : {}),
          ...(n.website ? { website: n.website } : {}),
          ...(n.lat != null && n.lng != null ? { lat: n.lat, lng: n.lng } : {}),
        },
      },
      { upsert: true }
    );
    if (res.upsertedCount) created++;
    else if (res.modifiedCount) updated++;
  }

  // Roster rows that vanished → mark inactive (license lapsed / store gone).
  const { modifiedCount: deactivated } = await Dispensary.updateMany(
    { state, source: 'roster', dedupeKey: { $nin: seenKeys } },
    { $set: { active: false } }
  );

  const geo = await geocodeMissing(state);
  const chains = await rechainState(state);
  const total = await Dispensary.countDocuments({ state, active: true, hidden: false });

  return {
    state, sourceKind, sourceUrl,
    fetchedRows: rows.length,
    filteredOut: filtered,
    imported: unique.length,
    created, updated, deactivated,
    geocoding: geo,
    chains,
    totalActive: total,
    approxExpected: cfg.approxRetail,
    lowCoverage: total < cfg.approxRetail * 0.5,
    headerMap: map,
    sourceErrors: errors,
    startedAt,
  };
}

// ── Shared OSM candidate → Dispensary roster upsert ──────────────────────────
// The ONE write path that turns raw OSM finds into roster pins, used by BOTH the
// human Field-Map scan (controllers/dispensary.scanOsm) AND the always-on cold-
// email finder (services/leadFinderRunner). Before this was shared, the finder
// discovered real dispensaries and — for any without a scrapeable email — threw
// them away; now every find is captured for phone/visit outreach on the Field
// Map instead of being lost. Cross-source dedup: an existing store at ~this spot
// with the same match key is the SAME storefront (fill missing phone/website
// from OSM rather than duplicate). Chains are persisted FLAGGED, not dropped —
// the roster surfaces already hide them, so nothing found is ever lost.
const OSM_MATCH_PAD = 0.02;      // ~2km — same-storefront cross-source match radius

// Best-effort USPS state from a freeform address tail; 'US' when unparsed (an
// accepted sentinel — `state` is required but a pin with an unknown state still
// renders and just can't be segment-derived).
function stateFromAddress(addr) {
  const m = String(addr || '').match(/\b([A-Z]{2})\b(?:\s+\d{5}(?:-\d{4})?)?\s*$/);
  return (m && m[1]) || 'US';
}

async function upsertOsmCandidates(candidates) {
  let added = 0, attached = 0;
  for (const c of (candidates || [])) {
    if (!c || c.lat == null || c.lng == null) continue; // no coords → can't pin it
    const mk = matchKey(c.name);
    // A known store (roster/google/earlier osm) at ~this spot with the same match
    // key is the SAME storefront — fill any missing phone/website from OSM (free
    // enrichment) instead of minting a duplicate pin.
    // eslint-disable-next-line no-await-in-loop
    const near = await Dispensary.findOne({
      matchKey: mk,
      lat: { $gte: c.lat - OSM_MATCH_PAD, $lte: c.lat + OSM_MATCH_PAD },
      lng: { $gte: c.lng - OSM_MATCH_PAD, $lte: c.lng + OSM_MATCH_PAD },
    });
    if (near) {
      let changed = false;
      if (!near.phone && c.phone) { near.phone = c.phone; changed = true; }
      if (!near.website && c.website) { near.website = c.website; changed = true; }
      // eslint-disable-next-line no-await-in-loop
      if (changed) { await near.save(); attached++; }
      continue;
    }
    const dedupeKey = c.osmId ? `osm:${c.osmId}` : `osm:${mk}|${c.lat.toFixed(4)},${c.lng.toFixed(4)}`;
    const chainName = detectKnownChain(c.name) || '';
    const st = stateFromAddress(c.address);
    // eslint-disable-next-line no-await-in-loop
    await Dispensary.updateOne(
      { dedupeKey },
      {
        $set: {
          state: st,
          name: c.name,
          address: c.address,
          lat: c.lat, lng: c.lng,
          phone: c.phone || '', website: c.website || '',
          source: 'osm', verified: false, active: true,
          // Segment: in a med-only state a medically-tagged or trusted-tag
          // find is a licensed MED dispensary; a name-net-only find (and any
          // find in a no-retail state) is a hemp/"bodega THC" shop.
          segment: deriveSegment(st, 'osm', { medical: !!c.medical || !!c.taggedCannabis }),
          isChain: !!chainName || !!c.chain,
          chainName,
          companyKey: deriveCompanyKey(c.name),
          matchKey: mk,
        },
        $setOnInsert: { hidden: false },  // never un-hide a store the owner rejected
      },
      { upsert: true },
    );
    added++;
  }
  return { added, attached };
}

module.exports = {
  ingestState,
  rechainState,
  geocodeMissing,
  upsertOsmCandidates,
  // exported for tests:
  parseCsv, sniffHeaders, normalizeRow, rowPasses, deriveCompanyKey, matchKey, stateFromAddress,
  rosterAttempts, rowMatchesState, csvStreamParser, collectAggregateRowsForState,
};
