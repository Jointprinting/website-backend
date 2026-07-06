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
  ri: { label: 'Rhode Island', bbox: [41.15, -71.91, 42.02, -71.12] },
  vt: { label: 'Vermont',      bbox: [42.73, -73.44, 45.02, -71.46] },
  me: { label: 'Maine',        bbox: [42.98, -71.08, 47.46, -66.95] },
  va: { label: 'Virginia',     bbox: [36.54, -83.68, 39.47, -75.24] },
  oh: { label: 'Ohio',         bbox: [38.40, -84.82, 41.98, -80.52] },
  mi: { label: 'Michigan',     bbox: [41.70, -90.42, 48.31, -82.12] },
  il: { label: 'Illinois',     bbox: [36.97, -91.51, 42.51, -87.02] },
  mn: { label: 'Minnesota',    bbox: [43.50, -97.24, 49.38, -89.49] },
  mo: { label: 'Missouri',     bbox: [35.99, -95.77, 40.61, -89.10] },
  az: { label: 'Arizona',      bbox: [31.33, -114.82, 37.00, -109.04] },
  co: { label: 'Colorado',     bbox: [36.99, -109.06, 41.00, -102.04] },
  nm: { label: 'New Mexico',   bbox: [31.33, -109.05, 37.00, -103.00] },
  nv: { label: 'Nevada',       bbox: [35.00, -120.01, 42.00, -114.04] },
  ca: { label: 'California',   bbox: [32.53, -124.41, 42.01, -114.13] },
  or: { label: 'Oregon',       bbox: [41.99, -124.57, 46.29, -116.46] },
  wa: { label: 'Washington',   bbox: [45.54, -124.85, 49.00, -116.92] },
  mt: { label: 'Montana',      bbox: [44.36, -116.05, 49.00, -104.04] },
  ak: { label: 'Alaska',       bbox: [51.21, -179.15, 71.44, -129.98] },
};
const DEFAULT_REGION = 'nj';

// The national rollout order the always-on lead engine advances through: NJ
// first, then outward by proximity, then the rest of the adult-use map. Each
// queue-aware refill run sweeps successive frontier states along this list —
// WRAPPING at the end, so it periodically loops back to catch newly opened
// dispensaries. Only ids present in REGIONS are valid.
const NATIONAL_ROLLOUT = [
  'nj', 'ny', 'pa', 'ct', 'de', 'md', 'ma', 'ri', 'vt', 'me',
  'va', 'oh', 'mi', 'il', 'mn', 'mo', 'az', 'co', 'nm', 'nv',
  'ca', 'or', 'wa', 'mt', 'ak',
];

// Bump when the discovery/enrichment/import logic materially improves (a wider
// Overpass net, better scraping…). Every sweep stamps the run with this. The
// always-on engine treats a state last swept at an OLDER version as STALE and
// quietly re-milks it in the background — so an improved finder retroactively
// upgrades already-covered states with ZERO manual action (the owner never
// presses "re-sweep"). History (undefined) reads as 0.
//   v1 → email-gated import
//   v2 → (superseded) email-optional + medical detail tags
//   v3 → mail-merge: email REQUIRED, RECREATIONAL-only, broadened name net that
//        also catches rec dispensaries whose name doesn't say "cannabis"
const FINDER_VERSION = 3;

function regionIds() { return Object.keys(REGIONS); }
function isRegion(id) { return Object.prototype.hasOwnProperty.call(REGIONS, id); }

// The region AFTER `region` in the rollout, wrapping at the end. Unknown → first.
// Pure + testable.
function nextRegionAfter(region, rollout = NATIONAL_ROLLOUT) {
  const i = rollout.indexOf(region);
  if (i < 0) return rollout[0];
  return rollout[(i + 1) % rollout.length];
}

// Legacy per-run frontier decision (kept for its tests + any manual tooling):
// a run that imported NO new leads is "dry"; after `advanceAfter` consecutive
// dry runs the frontier steps to the next region. The current lead engine
// advances via nextRegionAfter on every swept state instead (see
// leadFinderScheduler.runFrontierSweep). Pure + testable.
function decideFrontier({ region, created, dryStreak = 0, rollout = NATIONAL_ROLLOUT, advanceAfter = 2 }) {
  if ((Number(created) || 0) > 0) return { region, dryStreak: 0, advanced: false };
  const streak = (Number(dryStreak) || 0) + 1;
  if (streak >= advanceAfter) return { region: nextRegionAfter(region, rollout), dryStreak: 0, advanced: true };
  return { region, dryStreak: streak, advanced: false };
}

// The strong cannabis-retail NAME tokens the Overpass name-net widens to. These
// are the words a rec dispensary uses in its name EVEN WHEN a mapper never tagged
// it shop=cannabis — so a shop called "Garden State Budtenders" or "420 Bank"
// gets caught by name alone. Kept to high-signal tokens (no bare "green"/"leaf"/
// "wellness", which pull spas and florists); everything from the name-net is
// still junk-gated by NON_CANNABIS_NAME + the medical-only check below. `\b` is
// dropped here because Overpass's regex engine doesn't support it — the precise
// JS gate (CANNABIS_NAME) re-applies word boundaries when filtering.
const OVERPASS_NAME_RE = 'dispensar|cannabis|marijuana|weed|budtender|420|kush|ganja';

// One Overpass QL query for RECREATIONAL cannabis retailers in a bbox. Two nets:
//   1. TAG-based — the cannabis retail tags OSM uses (shop=cannabis / weed,
//      office=cannabis, cannabis:recreational). Trusted outright (medical-only
//      shops are filtered out downstream). Catches dispensaries with ANY name —
//      the whole point: a mapper-tagged shop is found regardless of what it's
//      called.
//   2. NAME-based — shops whose name carries a strong cannabis token
//      (OVERPASS_NAME_RE). A widening net for untagged shops; quality-gated in
//      parseOverpassElements (closed-out, medical-only, and non-cannabis matches
//      like pharmacy/vet/lawn-care are dropped) so coverage grows WITHOUT junk.
// Nodes AND ways (buildings); `out center` gives a way a lat/lon too. Pure + tested.
//
// `vertical` (optional) retargets the query to another business type — a brewery,
// a bodega/smoke shop — by swapping in that vertical's selectors (see
// services/leadVerticals.js). The DEFAULT (no vertical, or the dispensary
// vertical) keeps the original cannabis net verbatim, so the live dispensary
// sweep and every existing test are byte-for-byte unchanged.
function buildOverpassQuery(bbox, vertical) {
  const b = bbox.join(',');
  if (vertical && vertical.id !== 'dispensary' && typeof vertical.overpassSelectors === 'function') {
    return `[out:json][timeout:90];
(
${vertical.overpassSelectors(b)}
);
out center tags;`;
  }
  return `[out:json][timeout:90];
(
  node["shop"="cannabis"](${b});
  way["shop"="cannabis"](${b});
  node["office"="cannabis"](${b});
  way["office"="cannabis"](${b});
  node["shop"="weed"](${b});
  node["cannabis:recreational"](${b});
  way["cannabis:recreational"](${b});
  node["name"~"${OVERPASS_NAME_RE}",i](${b});
  way["name"~"${OVERPASS_NAME_RE}",i](${b});
);
out center tags;`;
}

// A cannabis:recreational value that means "yes, this shop sells recreational".
// OSM uses yes / only / licensed for a rec-licensed shop; "no" means medical-only.
function isRecCannabis(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'yes' || s === 'only' || s === 'licensed' || s === 'true';
}

// MEDICAL-ONLY (not recreational) — the owner sells to rec dispensaries, so these
// are skipped even when tagged shop=cannabis. The reliable signal is an explicit
// cannabis:recreational=no (dual-license shops tag it yes/omit it). Pure.
function isMedicalOnly(tags = {}) {
  const rec = String(tags['cannabis:recreational'] || '').trim().toLowerCase();
  return rec === 'no' || rec === 'false' || rec === 'none';
}

// The canonical "this IS a RECREATIONAL cannabis retailer" tag set — trusted
// outright. shop=cannabis/weed and office=cannabis in a rec-legal state serve
// rec; cannabis:recreational=yes/only/licensed is explicit. Medical-only shops
// (rec=no) are excluded. Pure + unit-tested.
function hasCannabisTag(tags = {}) {
  if (isMedicalOnly(tags)) return false;
  return tags.shop === 'cannabis' || tags.shop === 'weed' || tags.office === 'cannabis'
    || isRecCannabis(tags['cannabis:recreational']);
}

// A closed/dead POI — OSM marks these with lifecycle-prefixed keys (disused:shop,
// was:name, abandoned:…) or an explicit closed status. Never email a closed shop.
function isClosedPoi(tags = {}) {
  if (Object.keys(tags).some((k) => /^(disused|was|abandoned|demolished|removed|razed):/i.test(k))) return true;
  if (/^(disused|abandoned|vacant|closed)$/i.test(String(tags.shop || ''))) return true;
  return String(tags['business_status'] || '').toLowerCase() === 'closed';
}

// Strong cannabis-retail NAME tokens (the precise JS mirror of OVERPASS_NAME_RE,
// with word boundaries the Overpass engine can't express). A name-net hit must
// match one of these to count as a dispensary.
const CANNABIS_NAME = /dispensar|cannabis|marijuana|\bweed\b|budtender|\b420\b|\bkush\b|ganja/i;

// Carries a cannabis token but ISN'T a rec dispensary we'd cold-email — MEDICAL
// dispensaries/pharmacies, vets, the smoke/vape/head-shop crowd, hydroponic/grow
// suppliers, and lawn-and-garden "weed" shops (Weed Man, garden centers, feed &
// nursery). These are the junk the widened name-net would otherwise drag in.
const NON_CANNABIS_NAME = /pharmac|veterinar|hospit|\bmedical\b|\bmed(ical)? ?(marijuana|cannabis)|\bclinic\b|optical|dental|smoke ?shop|vape|head ?shop|\bglass\b|hydroponic|\bgrow\b|tobacc|\bpet\b|garden ?cent|\bnurser|landscap|\blawn\b|florist|\bfeed\b|weed ?man/i;

// Is this element a GOOD recreational dispensary lead? Closed / medical-only are
// always out. A trusted rec cannabis TAG → yes (any name). Otherwise a name-net
// hit must carry a strong cannabis token AND not match the junk/medical gate.
// Pure + unit-tested — the gate that keeps the widened net from wasting sends.
function isQualityLead(tags = {}, name = '') {
  if (isClosedPoi(tags)) return false;
  if (isMedicalOnly(tags)) return false;
  if (hasCannabisTag(tags)) return true;
  return CANNABIS_NAME.test(name) && !NON_CANNABIS_NAME.test(name);
}

// The big multi-state chains (MSOs) + notable multi-location retail brands.
// Emailing an individual store is pointless — corporate handles merch — so we
// skip them and focus on independents. Distinctive tokens only, to avoid false
// hits (and we only ever test dispensary candidates, so "cookies" = the brand).
const KNOWN_CHAINS = /\b(curaleaf|trulieve|cresco|sunnyside|rise dispensar[a-z]*|green thumb|verano|zen leaf|ascend|columbia care|cannabist|beyond ?hello|terrascend|apothecarium|the botanist|ethos|theory wellness|revolutionary clinics|garden remedies|planet 13|jushi|nature'?s medicines|cookies|verilife|med ?men|ayr wellness|insa|mu:?v|fluent|ilera|liberty (cannabis|health)|restore integrative|holistic industries|goodness growth|vireo|cansortium|acreage|gold flora|cookies|stiiizy|the ?source)\b/i;

// A big chain / MSO location? OSM's `brand:wikidata` marks recognized brands
// outright; otherwise match the known-chain name list against the brand + name.
// Pure + unit-tested.
function isBigChain(tags = {}, name = '') {
  if (tags['brand:wikidata']) return true;
  return KNOWN_CHAINS.test(`${tags.brand || ''} ${name}`);
}

const normBrandKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Mark chains: a candidate is a chain if isBigChain, OR its OSM `brand` repeats
// ≥ `threshold` times across the batch (catches regional chains not on the known
// list). Pure + unit-tested. Mutates each candidate's `.chain` flag.
function markChains(candidates, { threshold = 3 } = {}) {
  const brandCount = new Map();
  for (const c of candidates) {
    const bk = normBrandKey(c.brand);
    if (bk) brandCount.set(bk, (brandCount.get(bk) || 0) + 1);
  }
  return candidates.map((c) => {
    const bk = normBrandKey(c.brand);
    const repeated = !!bk && (brandCount.get(bk) || 0) >= threshold;
    return { ...c, chain: !!c.chain || repeated };
  });
}

// An element's coordinates. Nodes carry lat/lon directly; ways/relations queried
// with `out center` carry them under `.center`. Returns null when neither exists
// (a lead we can't place on the map). Pure.
function osmLatLng(el = {}) {
  const lat = el.lat != null ? el.lat : el.center?.lat;
  const lng = el.lon != null ? el.lon : el.center?.lon;
  if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return null;
  return { lat: Number(lat), lng: Number(lng) };
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
//
// `vertical` (optional) swaps the quality + chain gates for another business
// type's (see services/leadVerticals.js). The DEFAULT (no vertical, or the
// dispensary vertical) uses the original cannabis gates verbatim.
function parseOverpassElements(json, vertical) {
  const useVertical = vertical && vertical.id !== 'dispensary';
  const qualityGate = useVertical ? vertical.isQualityLead : isQualityLead;
  const chainGate = useVertical ? vertical.isBigChain : isBigChain;
  const elements = (json && Array.isArray(json.elements)) ? json.elements : [];
  const seen = new Set();
  const out = [];
  for (const el of elements) {
    const tags = el.tags || {};
    const name = String(tags.name || tags['official_name'] || tags['brand'] || '').trim();
    if (!name) continue;
    // Quality gate: a trusted tag for the vertical, or a genuine name-net hit,
    // never a closed POI. Keeps the widened net junk-free.
    if (!qualityGate(tags, name)) continue;
    const address = osmAddress(tags);
    const key = `${name.toLowerCase()}|${address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const coords = osmLatLng(el);
    out.push({
      name,
      address,
      // Coordinates so the Field Map can drop a pin (null when OSM has none —
      // the email/lead-finder path ignores these, the map path skips them).
      lat: coords ? coords.lat : null,
      lng: coords ? coords.lng : null,
      website: normalizeWebsite(tags.website || tags['contact:website'] || tags['website:official']),
      phone: String(tags.phone || tags['contact:phone'] || tags['phone:mobile'] || '').trim(),
      // OSM sometimes carries the email outright — a free hit, no scrape needed.
      email: String(tags.email || tags['contact:email'] || '').trim().toLowerCase(),
      osmId: el.type && el.id != null ? `${el.type}/${el.id}` : '',
      brand: String(tags.brand || '').trim(),
      chain: chainGate(tags, name), // big chain / MSO → skipped at import
    });
  }
  // Second pass: flag regional chains whose brand simply repeats a lot in the batch.
  return markChains(out);
}

// Discover dispensaries in an ARBITRARY bbox (network). Tries each Overpass
// endpoint in turn; returns the parsed candidates. Throws only if every endpoint
// fails, so the caller can surface a clean error. `bbox` is [south, west, north,
// east]. A shorter timeout suits interactive callers (the Field Map viewport
// scan) where a hung endpoint shouldn't block the request for 90s.
async function fetchDispensariesForBbox(bbox, { timeoutMs = OVERPASS_TIMEOUT_MS, vertical } = {}) {
  const query = buildOverpassQuery(bbox, vertical);
  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await axios.post(endpoint, `data=${encodeURIComponent(query)}`, {
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': POLITE_UA },
        validateStatus: () => true,
        maxContentLength: 25 * 1024 * 1024,
      });
      if (res.status === 200 && res.data) return parseOverpassElements(res.data, vertical);
      lastErr = new Error(`Overpass ${endpoint} → HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All Overpass endpoints failed');
}

// Discover leads in a named REGION (network). Thin wrapper over the bbox fetch.
// `vertical` (optional) retargets discovery to another business type; default is
// dispensaries. Returns { region, label, candidates }.
async function fetchDispensaries(regionId = DEFAULT_REGION, { vertical } = {}) {
  const id = isRegion(regionId) ? regionId : DEFAULT_REGION;
  const region = REGIONS[id];
  const candidates = await fetchDispensariesForBbox(region.bbox, { vertical });
  return { region: id, label: region.label, candidates };
}

module.exports = {
  REGIONS,
  DEFAULT_REGION,
  NATIONAL_ROLLOUT,
  FINDER_VERSION,
  regionIds,
  isRegion,
  fetchDispensaries,
  fetchDispensariesForBbox,
  // pure — unit-tested
  buildOverpassQuery,
  osmLatLng,
  osmAddress,
  normalizeWebsite,
  parseOverpassElements,
  isQualityLead,
  isClosedPoi,
  hasCannabisTag,
  isRecCannabis,
  isMedicalOnly,
  isBigChain,
  markChains,
  nextRegionAfter,
  decideFrontier,
};
