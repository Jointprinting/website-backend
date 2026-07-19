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
// The Overpass QL query below carries its own [timeout:90] — the SERVER's budget.
// The axios timeout must sit ABOVE it (not equal/below), or axios aborts the
// socket right as Overpass is flushing a large-but-successful response (or a
// partial-with-remark one) — which is exactly what was happening on dense states:
// the server finished at ~89s and the client had already given up. 100s gives the
// server's 90s budget room to complete plus transfer time.
const OVERPASS_QUERY_TIMEOUT_S = 90;
const OVERPASS_TIMEOUT_MS = 100_000;

// Bounding boxes: [south, west, north, east]. NJ first; neighbors staged for the
// "expand when NJ is dry" rollout. All 50 states + DC are mapped so the national
// rollout can genuinely cover the country (medical-heavy states matter now that
// medical dispensaries are their own vertical — see services/leadVerticals.js).
// Boxes are deliberately simple rectangles; they may bleed over borders, which is
// fine — parse-level dedupe by name+address and import-level dedupe by companyKey
// make an overlap harmless, while a too-tight box would MISS shops.
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
  // ── The rest of the map (rollout priority lives in NATIONAL_ROLLOUT below) ──
  ok: { label: 'Oklahoma',     bbox: [33.62, -103.00, 37.00, -94.43] },
  fl: { label: 'Florida',      bbox: [24.40, -87.63, 31.00, -79.97] },
  dc: { label: 'Washington DC',bbox: [38.79, -77.12, 39.00, -76.90] },
  nh: { label: 'New Hampshire',bbox: [42.70, -72.56, 45.31, -70.60] },
  wv: { label: 'West Virginia',bbox: [37.20, -82.65, 40.64, -77.72] },
  ky: { label: 'Kentucky',     bbox: [36.50, -89.57, 39.15, -81.96] },
  nc: { label: 'North Carolina',bbox: [33.84, -84.32, 36.59, -75.46] },
  sc: { label: 'South Carolina',bbox: [32.03, -83.35, 35.22, -78.54] },
  ga: { label: 'Georgia',      bbox: [30.36, -85.61, 35.00, -80.75] },
  tn: { label: 'Tennessee',    bbox: [34.98, -90.31, 36.68, -81.65] },
  in: { label: 'Indiana',      bbox: [37.77, -88.10, 41.76, -84.78] },
  wi: { label: 'Wisconsin',    bbox: [42.49, -92.89, 47.08, -86.25] },
  ia: { label: 'Iowa',         bbox: [40.36, -96.64, 43.50, -90.14] },
  ar: { label: 'Arkansas',     bbox: [33.00, -94.62, 36.50, -89.64] },
  la: { label: 'Louisiana',    bbox: [28.92, -94.04, 33.02, -88.82] },
  ms: { label: 'Mississippi',  bbox: [30.17, -91.66, 35.01, -88.10] },
  al: { label: 'Alabama',      bbox: [30.14, -88.48, 35.01, -84.89] },
  tx: { label: 'Texas',        bbox: [25.84, -106.65, 36.50, -93.51] },
  ut: { label: 'Utah',         bbox: [37.00, -114.05, 42.00, -109.04] },
  ks: { label: 'Kansas',       bbox: [36.99, -102.05, 40.00, -94.59] },
  ne: { label: 'Nebraska',     bbox: [39.99, -104.05, 43.00, -95.31] },
  sd: { label: 'South Dakota', bbox: [42.48, -104.06, 45.95, -96.44] },
  nd: { label: 'North Dakota', bbox: [45.94, -104.05, 49.00, -96.55] },
  id: { label: 'Idaho',        bbox: [41.99, -117.24, 49.00, -111.04] },
  wy: { label: 'Wyoming',      bbox: [40.99, -111.06, 45.01, -104.05] },
  hi: { label: 'Hawaii',       bbox: [18.86, -160.30, 22.30, -154.75] },
};
const DEFAULT_REGION = 'nj';

// The national rollout order the always-on lead engine advances through: NJ
// first, then outward by proximity, then the rest of the adult-use map. Each
// queue-aware refill run sweeps successive frontier states along this list —
// WRAPPING at the end, so it periodically loops back to catch newly opened
// dispensaries. Only ids present in REGIONS are valid.
//
// The first 25 keep their historical order (the live frontier resumes wherever
// it is — reordering would make it skip or re-tread states). The appended tail
// is ordered by MARKET SIZE first — Oklahoma has more dispensaries than any
// other state (its famously open license regime), then Florida's huge medical
// market — and then roughly by proximity to already-covered ground / remaining
// market size, so each frontier step milks the richest nearby ground next.
const NATIONAL_ROLLOUT = [
  'nj', 'ny', 'pa', 'ct', 'de', 'md', 'ma', 'ri', 'vt', 'me',
  'va', 'oh', 'mi', 'il', 'mn', 'mo', 'az', 'co', 'nm', 'nv',
  'ca', 'or', 'wa', 'mt', 'ak',
  'ok', 'fl',                                            // biggest new markets first
  'dc', 'nh', 'wv', 'ky',                                // adjacent to covered ground
  'nc', 'sc', 'ga', 'tn',                                // southeast corridor
  'in', 'wi', 'ia', 'ar',                                // midwest fill-in
  'la', 'ms', 'al', 'tx',                                // gulf south
  'ut', 'ks', 'ne', 'sd', 'nd',                          // plains/mountain
  'id', 'wy', 'hi',                                      // thinnest markets last
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
//   v4 → tile-splitting recovery for dense states (NY/CA sweeps that used to
//        time out now return; earlier v3 "coverage" of those states was
//        effectively empty) + a longer axios budget so Overpass can finish
//        instead of being aborted mid-flush. Re-milking every state under v4
//        is exactly the point of the bump.
const FINDER_VERSION = 4;

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
// The default (dispensary) selector block for one area string `b` — extracted
// so multi-area queries (corridor fill) can repeat it per chunk. Pure.
function dispensarySelectors(b) {
  return `  node["shop"="cannabis"](${b});
  way["shop"="cannabis"](${b});
  node["office"="cannabis"](${b});
  way["office"="cannabis"](${b});
  node["shop"="weed"](${b});
  node["cannabis:recreational"](${b});
  way["cannabis:recreational"](${b});
  node["name"~"${OVERPASS_NAME_RE}",i](${b});
  way["name"~"${OVERPASS_NAME_RE}",i](${b});`;
}

function selectorsFor(b, vertical) {
  if (vertical && vertical.id !== 'dispensary' && typeof vertical.overpassSelectors === 'function') {
    return vertical.overpassSelectors(b);
  }
  return dispensarySelectors(b);
}

function buildOverpassQuery(bbox, vertical) {
  const b = bbox.join(',');
  return `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];
(
${selectorsFor(b, vertical)}
);
out center tags;`;
}

// One query unioning the SAME selector net over several bboxes — the corridor
// fill's shape (a route chopped into chunk bboxes = one round trip for the
// whole drive instead of one per chunk). Pure.
function buildOverpassQueryMulti(bboxes, vertical) {
  const blocks = bboxes.map((bb) => selectorsFor(bb.join(','), vertical)).join('\n');
  return `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];
(
${blocks}
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
  if (rec === 'no' || rec === 'false' || rec === 'none') return true;
  // A shop tagged cannabis:medical (yes/only) with NO affirmative recreational tag
  // is a medical-only dispensary — a very common OSM shape the rec=no check misses.
  // The owner sells to REC shops, so skip it.
  const med = String(tags['cannabis:medical'] || '').trim().toLowerCase();
  if ((med === 'yes' || med === 'only' || med === 'licensed') && !isRecCannabis(tags['cannabis:recreational'])) return true;
  return false;
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
// suppliers, lawn-and-garden "weed" shops (Weed Man, garden centers, feed &
// nursery), and the kratom/kava/CBD-only storefronts that love calling
// themselves a "dispensary" (the corridor's kratom-shop bug: "X Kratom
// Dispensary" matched the name-net and nothing here said no). These are the
// junk the widened name-net would otherwise drag in.
const NON_CANNABIS_NAME = /pharmac|veterinar|hospit|\bmedical\b|\bmed(ical)? ?(marijuana|cannabis)|\bclinic\b|optical|dental|smoke ?shop|vape|head ?shop|\bglass\b|hydroponic|\bgrow\b|tobacc|\bpet\b|garden ?cent|\bnurser|landscap|\blawn\b|florist|\bfeed\b|weed ?man|kratom|\bkava\b|\bcbd\s*(only|store|shop|outlet|american shaman)\b/i;

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
      // Segment hints for the roster upsert (services/dispensaryStates
      // deriveSegment): medical-only tagging, and whether a TRUSTED cannabis
      // tag (vs a name-net-only hit) backed the find — in a med-only state a
      // mapper-tagged shop is a licensed med dispensary, a name-only hit is
      // usually a hemp storefront.
      medical: isMedicalOnly(tags),
      taggedCannabis: tags.shop === 'cannabis' || tags.shop === 'weed'
        || tags.office === 'cannabis'
        || !!tags['cannabis:recreational'] || !!tags['cannabis:medical'],
    });
  }
  // Second pass: flag regional chains whose brand simply repeats a lot in the batch.
  return markChains(out);
}

// Split a bbox [south, west, north, east] into its 4 quadrants (SW, SE, NW, NE).
// The quadrants tile the parent EXACTLY — shared mid edges, no gaps, no overlap
// beyond those edges — so a split-and-union sweep covers the same ground as the
// parent request. Pure + unit-tested.
function splitBbox(bbox) {
  const [s, w, n, e] = bbox;
  const midLat = (s + n) / 2;
  const midLng = (w + e) / 2;
  return [
    [s, w, midLat, midLng],       // SW
    [s, midLng, midLat, e],       // SE
    [midLat, w, n, midLng],       // NW
    [midLat, midLng, n, e],       // NE
  ];
}

// How many times a failing bbox may be quartered: depth 2 → a state degrades to
// at most 16 tiles. Deep enough that even NY/CA fit per-tile; shallow enough
// that a dead endpoint can't fan out into an unbounded request storm.
const MAX_SPLIT_DEPTH = 2;

// A runtime timeout Overpass reports INSIDE an HTTP 200: once output has begun
// the status is already committed, so a query that blows its [timeout:] budget
// mid-execution comes back as 200 + a `remark` ("runtime error: Query timed out
// in …") + a truncated (often empty) elements array. Accepting that as success
// is exactly how dense states used to record "swept: 0 found" — it MUST count
// as a failure so the endpoint fallback + quadrant split get their shot. PURE.
function isOverpassTimeoutRemark(data) {
  const remark = data && typeof data === 'object' ? String(data.remark || '') : '';
  return /timed?[ _-]?out|runtime error/i.test(remark);
}

// ONE Overpass request for a bbox, trying each endpoint in turn so one being
// down/rate-limited doesn't stall the sweep. Throws only if every endpoint fails.
async function fetchBboxOnce(bbox, { timeoutMs = OVERPASS_TIMEOUT_MS, vertical } = {}) {
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
      if (res.status === 200 && res.data) {
        // Partial-with-remark = the query died mid-run; the body is truncated.
        // Treat as failure so the next endpoint / the quadrant split engages.
        if (isOverpassTimeoutRemark(res.data)) {
          lastErr = new Error(`Overpass ${endpoint} → 200 with timeout remark: ${String(res.data.remark).slice(0, 120)}`);
          continue;
        }
        return parseOverpassElements(res.data, vertical);
      }
      lastErr = new Error(`Overpass ${endpoint} → HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All Overpass endpoints failed');
}

// Discover dispensaries in an ARBITRARY bbox (network). `bbox` is [south, west,
// north, east]. A shorter timeout suits interactive callers (the Field Map
// viewport scan) where a hung endpoint shouldn't block the request for 90s.
//
// DENSE-STATE RECOVERY: when the whole-bbox request fails on every endpoint
// (Overpass timeout, 429/504, network), the cause on a big state is almost
// always that the result set is too large for one query — so instead of giving
// up (which used to mark NY/CA "swept: 0 found"), split the bbox into 4
// quadrants and recurse (max depth 2 → up to 16 tiles), unioning the tiles and
// de-duping by OSM id. A quadrant that STILL fails at max depth is skipped while
// its siblings' results are kept — partial coverage beats total failure. Only
// when the parent AND every quadrant fail (endpoint truly down) does the error
// propagate, so the scheduler still sees a real failure as a failure.
async function fetchDispensariesForBbox(bbox, { timeoutMs = OVERPASS_TIMEOUT_MS, vertical, _depth = 0 } = {}) {
  let parentErr;
  try {
    return await fetchBboxOnce(bbox, { timeoutMs, vertical });
  } catch (err) {
    parentErr = err;
  }
  if (_depth >= MAX_SPLIT_DEPTH) throw parentErr;
  const seen = new Set();
  const out = [];
  let okTiles = 0;
  // Sequential on purpose (one in-flight Overpass request at a time) — this is
  // the recovery path for an already-strained server; parallel quadrants would
  // just re-trigger the rate-limit that got us here.
  for (const quad of splitBbox(bbox)) {
    try {
      const rows = await fetchDispensariesForBbox(quad, { timeoutMs, vertical, _depth: _depth + 1 });
      okTiles += 1;
      for (const c of rows) {
        // Union across tiles: a shop sitting on a shared tile edge (or in a
        // slightly-overlapping way geometry) can come back from two quadrants —
        // its OSM id is the stable identity. Name+address is the fallback for
        // the rare element without one.
        const key = c.osmId || `${String(c.name).toLowerCase()}|${String(c.address).toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
      }
    } catch (_e) {
      // Skip the dead quadrant; the siblings' coverage still counts.
    }
  }
  if (!okTiles) throw parentErr;
  // Re-run the repeated-brand pass over the UNION: a regional chain spread
  // 2-per-tile would dodge the per-tile threshold otherwise. markChains never
  // clears an existing flag, so per-tile verdicts are preserved.
  return markChains(out);
}

// Discover across SEVERAL bboxes in one Overpass round trip — the corridor
// fill (a route chopped into chunk bboxes). Best-effort by design: no quadrant
// recovery; the caller treats a throw as "no live fill this time" and serves
// DB rows. Endpoint fallback still applies.
async function fetchDispensariesForBboxes(bboxes, { timeoutMs = OVERPASS_TIMEOUT_MS, vertical } = {}) {
  const list = (bboxes || []).filter((b) => Array.isArray(b) && b.length === 4);
  if (!list.length) return [];
  const query = buildOverpassQueryMulti(list, vertical);
  let lastErr = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await axios.post(endpoint, `data=${encodeURIComponent(query)}`, {
        timeout: timeoutMs,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': POLITE_UA },
        validateStatus: () => true,
        maxContentLength: 25 * 1024 * 1024,
      });
      if (res.status === 200 && res.data) {
        if (isOverpassTimeoutRemark(res.data)) {
          lastErr = new Error(`Overpass ${endpoint} → 200 with timeout remark: ${String(res.data.remark).slice(0, 120)}`);
          continue;
        }
        return parseOverpassElements(res.data, vertical);
      }
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
  fetchDispensariesForBboxes,
  // pure — unit-tested
  splitBbox,
  isOverpassTimeoutRemark,
  buildOverpassQuery,
  buildOverpassQueryMulti,
  dispensarySelectors,
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
