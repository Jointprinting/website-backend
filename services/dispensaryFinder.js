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
// Overpass net, better scraping, email-optional import…). Every sweep stamps the
// run with this. The always-on engine treats a state last swept at an OLDER
// version as STALE and quietly re-milks it in the background — so an improved
// finder retroactively upgrades already-covered states with ZERO manual action
// (the owner never presses "re-sweep"). History (undefined) reads as 0.
//   v1 → email-gated import (dispensaries needed a scraped email to land)
//   v2 → email-optional import + cannabis:* detail-tag discovery net
const FINDER_VERSION = 2;

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

// One Overpass QL query for cannabis retailers in a bbox. Two nets:
//   1. TAG-based — the canonical dispensary tags OSM uses (shop=cannabis, etc.).
//      High precision; trusted outright.
//   2. NAME-based — shops literally named "…Dispensary". A widening net for
//      mistagged/untagged shops, but DELIBERATELY narrow: only the word
//      "dispensary" (a strong dispensary signal), not "cannabis"/"marijuana"
//      (which pull cafes, doctors, lawyers, museums). Everything from net 2 is
//      quality-gated in parseOverpassElements (closed-out + non-cannabis
//      "dispensary" like pharmacy/veterinary are dropped) so coverage grows
//      WITHOUT dragging in junk leads.
// Nodes AND ways (buildings); `out center` gives a way a lat/lon too. Pure + tested.
function buildOverpassQuery(bbox) {
  const b = bbox.join(',');
  return `[out:json][timeout:90];
(
  node["shop"="cannabis"](${b});
  way["shop"="cannabis"](${b});
  node["office"="cannabis"](${b});
  way["office"="cannabis"](${b});
  node["shop"="weed"](${b});
  node["cannabis:recreational"](${b});
  way["cannabis:recreational"](${b});
  node["cannabis:medical"](${b});
  way["cannabis:medical"](${b});
  node["name"~"dispensary",i](${b});
  way["name"~"dispensary",i](${b});
);
out center tags;`;
}

// The canonical "this IS a cannabis retailer" tag set — trusted outright. Beyond
// the shop/office tags, a POI carrying OSM's dispensary DETAIL tags
// (cannabis:recreational / cannabis:medical) is unambiguously a cannabis
// retailer even when a mapper never added shop=cannabis — a real coverage gap in
// states like NJ. Any value counts (a medical-only shop is tagged
// cannabis:recreational=no; it's still a dispensary lead).
function hasCannabisTag(tags = {}) {
  return tags.shop === 'cannabis' || tags.shop === 'weed' || tags.office === 'cannabis'
    || 'cannabis:recreational' in tags || 'cannabis:medical' in tags;
}

// A closed/dead POI — OSM marks these with lifecycle-prefixed keys (disused:shop,
// was:name, abandoned:…) or an explicit closed status. Never email a closed shop.
function isClosedPoi(tags = {}) {
  if (Object.keys(tags).some((k) => /^(disused|was|abandoned|demolished|removed|razed):/i.test(k))) return true;
  if (/^(disused|abandoned|vacant|closed)$/i.test(String(tags.shop || ''))) return true;
  return String(tags['business_status'] || '').toLowerCase() === 'closed';
}

// Names that say "dispensary" but AREN'T a cannabis dispensary — pharmacies,
// vets, hospitals, and the head/smoke/vape-shop crowd. These are the junk the
// wider name-net would otherwise drag in.
const NON_CANNABIS_NAME = /pharmac|veterinar|hospit|\bmedical\b|\bclinic\b|optical|dental|smoke ?shop|vape|head ?shop|\bglass\b|hydroponic|tobacc|\bpet\b/i;

// Is this element a GOOD dispensary lead? Trusted cannabis tag → yes. Otherwise
// (name-only hit) it must literally be a "…dispensary" and NOT a pharmacy/vet/
// smoke-shop. Closed POIs are always out. Pure + unit-tested — this is the
// quality gate that keeps the widened net from wasting the owner's sends.
function isQualityLead(tags = {}, name = '') {
  if (isClosedPoi(tags)) return false;
  if (hasCannabisTag(tags)) return true;
  return /dispensary/i.test(name) && !NON_CANNABIS_NAME.test(name);
}

// The big multi-state chains (MSOs) + notable multi-location retail brands.
// Emailing an individual store is pointless — corporate handles merch — so we
// skip them and focus on independents. Distinctive tokens only, to avoid false
// hits (and we only ever test dispensary candidates, so "cookies" = the brand).
const KNOWN_CHAINS = /\b(curaleaf|trulieve|cresco|sunnyside|rise dispensar[a-z]*|green thumb|verano|zen leaf|ascend|columbia care|cannabist|beyond ?hello|terrascend|apothecarium|the botanist|ethos|theory wellness|revolutionary clinics|garden remedies|planet 13|jushi|nature'?s medicines|cookies)\b/i;

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
function parseOverpassElements(json) {
  const elements = (json && Array.isArray(json.elements)) ? json.elements : [];
  const seen = new Set();
  const out = [];
  for (const el of elements) {
    const tags = el.tags || {};
    const name = String(tags.name || tags['official_name'] || tags['brand'] || '').trim();
    if (!name) continue;
    // Quality gate: trusted cannabis tag, or a genuine (non-pharmacy) "dispensary"
    // by name, and never a closed POI. Keeps the widened net junk-free.
    if (!isQualityLead(tags, name)) continue;
    const address = osmAddress(tags);
    const key = `${name.toLowerCase()}|${address.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      address,
      website: normalizeWebsite(tags.website || tags['contact:website'] || tags['website:official']),
      phone: String(tags.phone || tags['contact:phone'] || tags['phone:mobile'] || '').trim(),
      // OSM sometimes carries the email outright — a free hit, no scrape needed.
      email: String(tags.email || tags['contact:email'] || '').trim().toLowerCase(),
      osmId: el.type && el.id != null ? `${el.type}/${el.id}` : '',
      brand: String(tags.brand || '').trim(),
      chain: isBigChain(tags, name), // big MSO / recognized chain → skipped at import
    });
  }
  // Second pass: flag regional chains whose brand simply repeats a lot in the batch.
  return markChains(out);
}

// Discover dispensaries in a region (network). Tries each Overpass endpoint in
// turn; returns { region, label, candidates }. Throws only if every endpoint
// fails, so the caller can surface a clean error.
async function fetchDispensaries(regionId = DEFAULT_REGION) {
  const id = isRegion(regionId) ? regionId : DEFAULT_REGION;
  const region = REGIONS[id];
  const query = buildOverpassQuery(region.bbox);
  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await axios.post(endpoint, `data=${encodeURIComponent(query)}`, {
        timeout: OVERPASS_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': POLITE_UA },
        validateStatus: () => true,
        maxContentLength: 25 * 1024 * 1024,
      });
      if (res.status === 200 && res.data) {
        return { region: id, label: region.label, candidates: parseOverpassElements(res.data) };
      }
      lastErr = new Error(`Overpass ${endpoint} → HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All Overpass endpoints failed');
}

module.exports = {
  REGIONS,
  DEFAULT_REGION,
  NATIONAL_ROLLOUT,
  FINDER_VERSION,
  regionIds,
  isRegion,
  fetchDispensaries,
  // pure — unit-tested
  buildOverpassQuery,
  osmAddress,
  normalizeWebsite,
  parseOverpassElements,
  isQualityLead,
  isClosedPoi,
  hasCannabisTag,
  isBigChain,
  markChains,
  nextRegionAfter,
  decideFrontier,
};
