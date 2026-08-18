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
const SiteSetting = require('../models/SiteSetting');
const { ROSTER_STATES, MED_STATES, deriveSegment } = require('./dispensaryStates');
const { assignChains, detectKnownChain } = require('./dispensaryChains');

// ── Persisted per-state roster source overrides ──────────────────────────────
//
// Roster URLs rot: a regulator moves a dataset, a community aggregate is
// renamed, and the affected states quietly go OSM-only until someone notices.
// The ingest already accepted a per-REQUEST sourceUrlOverride, but that fixed
// one run — the 6-hourly autopilot went straight back to the dead URL. These
// overrides persist in SiteSetting, so re-pointing a state from the admin UI
// sticks for every later ingest WITHOUT a deploy (which is what the module
// header has always claimed). Shape: { CO: 'https://…', PA: '…' }.
const ROSTER_SOURCE_KEY = 'dispensaryRosterSources';

// ── Last ingest attempt, per state ───────────────────────────────────────────
//
// The ingest report already knew everything needed to explain an empty state
// (rows fetched, rows filtered out, which columns were sniffed, source errors)
// — and threw it all away into a console line nobody reads. So a state that
// fetched 2,400 licenses and filtered out 2,400 of them looked, from every
// surface the owner can see, identical to a state nobody had loaded yet.
// Persisting the last attempt is what makes that diagnosable from the road.
const INGEST_STATUS_KEY = 'dispensaryIngestStatus';

async function getIngestStatus() {
  try {
    const row = await SiteSetting.findOne({ key: INGEST_STATUS_KEY }).lean();
    const val = row && row.value;
    return val && typeof val === 'object' ? val : {};
  } catch {
    return {};
  }
}

/** Record one state's attempt. Never throws — bookkeeping must not break an ingest. */
async function recordIngestAttempt(state, entry) {
  try {
    const st = String(state || '').toUpperCase();
    if (!st) return;
    const current = await getIngestStatus();
    await SiteSetting.updateOne(
      { key: INGEST_STATUS_KEY },
      {
        $set: {
          key: INGEST_STATUS_KEY,
          value: { ...current, [st]: { at: new Date(), ...entry } },
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  } catch { /* best effort */ }
}

/**
 * ingestState + durable bookkeeping. Every automatic and manual path goes
 * through this so the "why is this state empty" trail is always written.
 * Re-throws on failure (callers decide) after recording the error.
 */
async function ingestStateTracked(state, opts = {}) {
  try {
    const report = await ingestState(state, opts);
    await recordIngestAttempt(state, {
      ok: true,
      sourceKind: report.sourceKind,
      sourceUrl: report.sourceUrl,
      fetchedRows: report.fetchedRows,
      stateRows: report.stateRows,
      filteredOut: report.filteredOut,
      relaxedFallback: report.relaxedFallback,
      imported: report.imported,
      created: report.created,
      totalActive: report.totalActive,
      lowCoverage: report.lowCoverage,
      headerMap: report.headerMap,
      geocoded: report.geocoding && report.geocoding.geocoded,
      geocodeNote: (report.geocoding && report.geocoding.message) || '',
      sourceErrors: report.sourceErrors || [],
    });
    return report;
  } catch (err) {
    await recordIngestAttempt(state, {
      ok: false,
      error: err.message,
      attempts: err.attempts || [],
    });
    throw err;
  }
}

async function getRosterOverrides() {
  try {
    const row = await SiteSetting.findOne({ key: ROSTER_SOURCE_KEY }).lean();
    const val = row && row.value;
    return val && typeof val === 'object' ? val : {};
  } catch {
    return {};   // a settings read must never break an ingest
  }
}

/** Set (url) or clear (falsy url) one state's roster override. Returns the map. */
async function setRosterOverride(state, url) {
  const st = String(state || '').toUpperCase();
  if (!st) throw Object.assign(new Error('state is required.'), { statusCode: 400 });
  const current = await getRosterOverrides();
  const next = { ...current };
  if (url) next[st] = String(url);
  else delete next[st];
  await SiteSetting.updateOne(
    { key: ROSTER_SOURCE_KEY },
    { $set: { key: ROSTER_SOURCE_KEY, value: next, updatedAt: new Date() } },
    { upsert: true },
  );
  return next;
}

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

// An ACTUAL storefront noun, as opposed to the generic word "retail". Colorado
// names EVERY adult-use license class "Retail Marijuana <something>" — Retail
// Marijuana Cultivation Facility, Retail Marijuana Products Manufacturer,
// Retail Marijuana Testing Facility — so the old
// `NON_RETAIL && !RETAILISH` guard let grows, kitchens and labs through on the
// strength of the word "Retail" alone, and they'd have landed on the map as
// dispensaries. A dual-licensed row ("Dispensary and Cultivation") still keeps
// its storefront noun and is correctly kept.
const STOREFRONT = /dispensar|store(front)?|microbusiness|hybrid|provisioning|retailer/i;
const MED_STOREFRONT = /dispensar|store(front)?|pharmacy|treatment[\s-]*center|mmtc|provisioning/i;

/**
 * Does this roster row look like a retail location for its market?
 *
 * `relaxed` drops the "must look retail-ish" requirement while STILL excluding
 * clear non-retail classes. It is the second pass used when the strict gate
 * rejected literally everything — see ingestState. That happens when the
 * sniffed "type" column isn't really a license class (an opaque code, a
 * business-entity type), in which case demanding retail words filters out an
 * entire state's roster and reports a perfectly "successful" empty ingest.
 */
function rowPasses(row, map, typeFilter, { medicalMarket = false, relaxed = false, dualLicence = false } = {}) {
  const type = map.licenseType ? String(row[map.licenseType] || '') : '';
  const status = map.licenseStatus ? String(row[map.licenseStatus] || '') : '';
  if (status && DEAD_STATUS.test(status)) return false;
  if (typeFilter) return typeFilter.test(type);
  if (type) {
    const retailish = medicalMarket ? MED_RETAILISH : RETAILISH;
    const storefront = medicalMarket ? MED_STOREFRONT : STOREFRONT;
    // Non-retail activity disqualifies unless the row also names a storefront.
    if (NON_RETAIL.test(type) && !storefront.test(type)) return false;
    // ...unless this state issues medical certificates to real walk-in shops.
    //
    // The rule keeps a rec state's medical-PROGRAM entities out of a retail
    // roster, and for somewhere like New York that is right: the medical side is
    // a separate registered-organization regime, not a storefront licence.
    // Nevada is not that. Its CCB issues "Medical Marijuana Dispensary" to
    // ordinary shops on the Strip, most of which hold an adult-use certificate
    // too — so the anchored pattern matched, and every medical-certificate store
    // in Las Vegas was discarded before it could become a pin.
    //
    // Which regime a state runs is a fact about the state, so it lives on the
    // state's roster config rather than being inferred here. Storefront word
    // still required, same shape as the NON_RETAIL rule two lines up.
    if (!medicalMarket && MEDICAL_ONLY_TYPE.test(type.trim())
      && !(dualLicence && STOREFRONT.test(type))) return false;
    if (!relaxed && !retailish.test(type)) return false;
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

// ── Roster source health ─────────────────────────────────────────────────────
//
// Is a roster URL still alive? Nearly every state's roster (and every state's
// LAST-RESORT fallback) is one community aggregate, so a single dead host can
// silently take the whole national map OSM-only — the failure mode is invisible
// from the map itself, which just looks like "no dispensaries here". This gives
// a direct answer instead of a guess.
//
// HEAD first (free — we only want liveness, not a 100MB body); some CDNs refuse
// HEAD, so fall back to a 2KB ranged GET.
async function probeSource(url, { timeout = 15_000 } = {}) {
  if (!url) return { ok: false, status: 0, error: 'no url configured' };
  try {
    const res = await axios.head(url, { timeout, maxRedirects: 5, validateStatus: () => true });
    if (res.status >= 200 && res.status < 300) {
      const len = parseInt(res.headers['content-length'] || '', 10);
      const ctype = String(res.headers['content-type'] || '');
      // A 200 serving HTML is a portal error/login page, not a roster. Reporting
      // that as "ALIVE" is worse than reporting nothing — it sends you looking
      // in the wrong place. Fall through to the ranged GET to see the body.
      if (!/text\/html/i.test(ctype)) {
        return { ok: true, status: res.status, contentType: ctype, bytes: isFinite(len) ? len : null };
      }
    }
    // 405/501 = HEAD unsupported; anything else is a real answer.
    if (res.status !== 405 && res.status !== 501) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
  } catch { /* fall through to the ranged GET */ }
  try {
    const res = await axios.get(url, {
      timeout, maxRedirects: 5, responseType: 'text',
      headers: { Range: 'bytes=0-2047' }, validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 400) {
      const body = String(res.data || '');
      const looksHtml = /^\s*<(!doctype|html)/i.test(body) || /text\/html/i.test(String(res.headers['content-type'] || ''));
      // A roster that answers 200 with an HTML error page is still broken.
      return {
        ok: !looksHtml,
        status: res.status,
        looksHtml,
        sample: body.slice(0, 160).replace(/\s+/g, ' ').trim(),
        ...(looksHtml ? { error: `HTTP ${res.status} but served HTML, not data` } : {}),
      };
    }
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

/** Probe the configured roster source for each state (respecting saved
 *  overrides), a few at a time so we never fan out dozens of requests at once. */
async function rosterSourceHealth(states = null, { concurrency = 4 } = {}) {
  const overrides = await getRosterOverrides();
  const codes = (states && states.length ? states : Object.keys(ROSTER_STATES))
    .map((s) => String(s).toUpperCase())
    .filter((s) => ROSTER_STATES[s]);
  const out = [];
  for (let i = 0; i < codes.length; i += concurrency) {
    const batch = codes.slice(i, i + concurrency);
    // eslint-disable-next-line no-await-in-loop
    const probed = await Promise.all(batch.map(async (code) => {
      const cfg = ROSTER_STATES[code];
      const url = overrides[code] || cfg.roster.url || '';
      const kind = overrides[code] ? 'override' : cfg.roster.kind;
      if (!url) return { state: code, name: cfg.name, kind, url: '', ok: false, error: 'no machine-readable roster configured (sweep-seeded)' };
      return { state: code, name: cfg.name, kind, url, ...(await probeSource(url)) };
    }));
    out.push(...probed);
  }
  // The shared last-resort aggregate: if THIS is dead, every fallback is dead.
  const aggregateUrl = 'https://huggingface.co/datasets/cannlytics/cannabis_licenses/resolve/main/data/all/licenses-all-latest.csv';
  const aggregate = { url: aggregateUrl, ...(await probeSource(aggregateUrl)) };
  const dead = out.filter((r) => !r.ok);
  return {
    checkedAt: new Date(),
    total: out.length,
    alive: out.length - dead.length,
    deadCount: dead.length,
    aggregate,
    states: out,
  };
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

// `budgetMs` bounds the whole pass. Geocoding is sequential with a 10s
// per-request timeout, so an unbounded 300-row batch can run for the better
// part of an hour — fine for the background autopilot, but the ingest is also
// reachable from a button on the Field Map, and that request has to come back
// while the owner is still looking at it. Rows left over are reported in
// `remaining` and picked up by the next pass.
async function geocodeMissing(state, { limit = 300, budgetMs = 45_000 } = {}) {
  const token = process.env.MAPBOX_TOKEN || process.env.REACT_APP_MAPBOX_TOKEN;
  if (!token) return { geocoded: 0, skipped: 0, message: 'MAPBOX_TOKEN not set — skipped geocoding.' };
  const docs = await Dispensary.find({
    state, active: true, hidden: false,
    $or: [{ lat: null }, { lng: null }],
    address: { $ne: '' },
  }).limit(limit);
  const deadline = Date.now() + budgetMs;
  let geocoded = 0, failed = 0, skipped = 0;
  for (const doc of docs) {
    if (Date.now() > deadline) { skipped++; continue; }
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
  return {
    geocoded, failed, skipped,
    remaining: skipped + (docs.length === limit ? 1 : 0),
    ...(skipped ? { message: `geocoding budget reached — ${skipped} rows deferred to the next pass` } : {}),
  };
}

// ── Chain pass over one state (or all) ───────────────────────────────────────

async function rechainState(state) {
  const filter = { active: true, hidden: false };
  if (state) filter.state = state;
  // city + companyKey + address are what let assignChains tell a real chain from
  // an artefact: the city so a metro's generically-named shops don't collapse to
  // the city name and fuse, and companyKey/address so a store holding two
  // licences (Nevada issues medical and adult-use separately) counts once.
  // Projecting only name+licensee made both of those impossible.
  const docs = await Dispensary.find(filter, { name: 1, licensee: 1, city: 1, companyKey: 1, address: 1 }).lean();
  const chainMap = assignChains(docs.map((d) => ({
    name: d.name, licensee: d.licensee, city: d.city, companyKey: d.companyKey, address: d.address,
  })));
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
  // A per-request override still wins; otherwise fall back to a persisted one
  // so a repaired source survives every later autopilot tick.
  let { sourceUrlOverride = null } = opts;
  let overrideSource = sourceUrlOverride ? 'request' : null;
  if (!sourceUrlOverride) {
    const saved = (await getRosterOverrides())[String(state).toUpperCase()];
    if (saved) { sourceUrlOverride = saved; overrideSource = 'saved'; }
  }
  const { rows, sourceUrl, sourceKind, errors } = await fetchRoster(state, { ...opts, sourceUrlOverride });
  const cfg = ROSTER_STATES[state];
  const medicalMarket = !!MED_STATES[state];

  const headers = Object.keys(rows[0] || {});
  const map = sniffHeaders(headers);
  const typeFilter = cfg.roster.typeFilter || null;

  // Rows for THIS state (the all-states aggregate carries the whole country).
  const stateRows = sourceKind === 'cannlytics-all'
    ? rows.filter((row) => rowMatchesState(row, map, state, cfg.name))
    : rows;

  const collect = (relaxed) => {
    const out = [];
    for (const row of stateRows) {
      if (!rowPasses(row, map, typeFilter, { medicalMarket, relaxed, dualLicence: !!cfg.dualLicence })) continue;
      const n = normalizeRow(row, map, state, sourceUrl);
      if (n) out.push(n);
    }
    return out;
  };

  let normalized = collect(false);

  // SAFETY NET: a roster that yielded rows but matched ZERO retail locations is
  // almost never an empty market — it's the type gate reading a column that
  // isn't a license class. That produced a "successful" ingest reporting 0
  // imported, which meant no error, no failure cooldown, and a state that
  // retried forever and stayed permanently empty while the map cheerfully said
  // "LOADING ROSTER" (exactly how Colorado sat at zero with a live source).
  // Retry once with the relaxed gate, which still drops grows/labs/transport.
  let relaxedFallback = false;
  if (!normalized.length && stateRows.length >= 20) {
    normalized = collect(true);
    relaxedFallback = normalized.length > 0;
  }
  const filtered = stateRows.length - normalized.length + (rows.length - stateRows.length);

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
    state, sourceKind, sourceUrl, overrideSource,
    fetchedRows: rows.length,
    stateRows: stateRows.length,
    filteredOut: filtered,
    relaxedFallback,
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
  getRosterOverrides, setRosterOverride, ROSTER_SOURCE_KEY,
  getIngestStatus, recordIngestAttempt, ingestStateTracked, INGEST_STATUS_KEY,
  probeSource, rosterSourceHealth,
  // exported for tests:
  parseCsv, sniffHeaders, normalizeRow, rowPasses, deriveCompanyKey, matchKey, stateFromAddress,
  rosterAttempts, rowMatchesState, csvStreamParser, collectAggregateRowsForState,
};
