// services/leadVerticals.js
//
// The lead-finder is no longer cannabis-only. A VERTICAL is a recipe for finding
// one KIND of business on the free OpenStreetMap/Overpass map: which OSM tags mark
// it, a widening name-net, a quality gate that keeps junk out, and a big-chain
// filter (emailing a corporate location is pointless — HQ handles merch). Each
// campaign targets one vertical, so the same free engine can hunt dispensaries,
// breweries, or corner-store/smoke-shop leads without touching a paid API.
//
// dispensaries stays the DEFAULT and its behavior is unchanged — this vertical
// simply wraps the exact gates that already live (and are unit-tested) in
// dispensaryFinder.js. The generic finder (dispensaryFinder.buildOverpassQuery /
// parseOverpassElements, parameterized by a vertical) runs the dispensary path
// byte-for-byte when the vertical is the default, so nothing about the live
// dispensary sweep changes.
//
// Adding a vertical is intentionally self-contained: define its selectors +
// gates here and it becomes selectable on a campaign; the engine then sweeps
// every state for it and enrollment only draws from its own tagged pool. OSM tag
// facts below are sourced from the OSM Wiki (Tag:craft=brewery, Tag:shop=tobacco,
// Tag:shop=e-cigarette, Tag:shop=convenience, Key:brand:wikidata).

const {
  isQualityLead: dispensaryIsQualityLead,
  isBigChain: dispensaryIsBigChain,
  isClosedPoi,
  FINDER_VERSION: DISPENSARY_FINDER_VERSION,
} = require('./dispensaryFinder');

// ── Shared helpers ───────────────────────────────────────────────────────────

// A gas-station convenience store — OSM often puts shop=convenience on the SAME
// node as amenity=fuel (or a fuel:* detail). These are chain c-stores, not the
// independent bodega we want. Pure.
function isFuelStation(tags = {}) {
  if (String(tags.amenity || '').toLowerCase() === 'fuel') return true;
  return Object.keys(tags).some((k) => /^fuel:/i.test(k));
}

// A recognized brand/chain location per OSM's Name Suggestion Index, which stamps
// brand:wikidata on every chain it knows. Independents almost never carry it, so
// its PRESENCE is the cheapest, most reliable chain signal. Pure.
function hasBrandWikidata(tags = {}) {
  return !!tags['brand:wikidata'];
}

// ── DISPENSARIES (default) ───────────────────────────────────────────────────
// Unchanged: delegates to the exact, unit-tested cannabis gates in
// dispensaryFinder.js. overpassSelectors is intentionally absent — the generic
// query builder keeps its original inline dispensary net when the vertical is the
// default, so the live dispensary sweep is byte-for-byte identical.
const dispensary = {
  id: 'dispensary',
  label: 'Dispensaries',
  short: 'dispensaries',
  tag: 'dispensary',                 // CRM tag stamped on imported leads
  finderVersion: DISPENSARY_FINDER_VERSION,
  isQualityLead: dispensaryIsQualityLead,
  isBigChain: dispensaryIsBigChain,
};

// ── BREWERIES / MICROBREWERIES / TAPROOMS ────────────────────────────────────
// OSM marks craft brewers with craft=brewery and brewpubs/taprooms with
// microbrewery=yes (on a pub/bar too). industrial=brewery / man_made=works+beer
// are MACRO plants — excluded (they don't buy indie merch). The name-net catches
// brewers a mapper never tagged; the JS gate (below) refines it and drops coffee
// "roasters/cold brew", cideries, distilleries, home-brew supply, and plain bars.
const BREWERY_OVERPASS_NAME_RE = 'brew|taproom|ale ?works|beer ?works|beer ?co|cerveceria|brauerei';
// Precise JS mirror with word boundaries (the Overpass engine lacks \b). Requires
// a real brewer token — "brew" alone (coffee) is not enough on its own.
const BREWERY_NAME = /\b(brew(ing|ery|ers|works?|house|pub)|brewpub|tap ?room|ale ?works|beer ?works|beer ?co\b|cervecer[ií]a|brauerei)\b/i;
// Carries a brewer-ish token but ISN'T an indie brewery we'd cold-email: coffee
// (roasters / cold brew / nitro / espresso / cafe), other drinks (kombucha, tea,
// cider, winery, distillery, meadery), and retail/supply (home-brew, bottle shop,
// growler stations).
const BREWERY_JUNK = /coffee|roaster|roasting|cold ?brew|nitro|espresso|caf[eé]|kombucha|\btea\b|cider|winer|vineyard|distiller|meade?ry|home ?brew|bottle ?shop|growler|\bsupply\b/i;
// Macro / macro-owned brands + a few "too big to need a vendor" indies. A taproom
// of one of these is corporate, not a lead. Distinctive tokens only.
const BREWERY_CHAINS = /\b(budweiser|bud light|michelob|busch|natural light|stella artois|shock top|goose island|elysian|10 barrel|golden road|blue point|breckenridge|karbach|devils backbone|wicked weed|coors|miller lite|miller high life|blue moon|keystone|hamm'?s|leinenkugel|terrapin|hop valley|corona|modelo|pacifico|heineken|dos equis|tecate|lagunitas|pabst|old milwaukee|schlitz|colt 45|lone star|rainier|national bohemian|sam ?adams|samuel adams|boston beer|yuengling|sierra nevada|new belgium|founders brewing|bell'?s brewery)\b/i;

// A production/industrial (macro) brewery, not a craft indie. Pure.
function isMacroBrewery(tags = {}) {
  if (String(tags.industrial || '').toLowerCase() === 'brewery') return true;
  return String(tags.man_made || '').toLowerCase() === 'works' && /beer/i.test(String(tags.product || ''));
}
// A trusted craft-brewer TAG (not macro). Pure.
function hasBreweryTag(tags = {}) {
  if (isMacroBrewery(tags)) return false;
  if (String(tags.craft || '').toLowerCase() === 'brewery') return true;
  if (String(tags.microbrewery || '').toLowerCase() === 'yes') return true;
  if (String(tags.building || '').toLowerCase() === 'brewery') return true;
  return false;
}
function breweryIsBigChain(tags = {}, name = '') {
  return BREWERY_CHAINS.test(`${tags.brand || ''} ${name}`);
}
// Is this a good indie-brewery lead? Closed / macro are always out. A trusted
// craft tag → yes (any name). Otherwise a name-net hit must carry a real brewer
// token AND not match the coffee/other-drink/supply junk gate. Pure + unit-tested.
function breweryIsQualityLead(tags = {}, name = '') {
  if (isClosedPoi(tags)) return false;
  if (isMacroBrewery(tags)) return false;
  if (hasBreweryTag(tags)) return true;
  return BREWERY_NAME.test(name) && !BREWERY_JUNK.test(name);
}
function breweryOverpassSelectors(b) {
  return [
    `  node["craft"="brewery"](${b});`,
    `  way["craft"="brewery"](${b});`,
    `  node["microbrewery"="yes"](${b});`,
    `  way["microbrewery"="yes"](${b});`,
    `  way["building"="brewery"](${b});`,
    `  node["amenity"~"^(pub|bar)$"]["microbrewery"="yes"](${b});`,
    `  way["amenity"~"^(pub|bar)$"]["microbrewery"="yes"](${b});`,
    `  node["name"~"${BREWERY_OVERPASS_NAME_RE}",i](${b});`,
    `  way["name"~"${BREWERY_OVERPASS_NAME_RE}",i](${b});`,
  ].join('\n');
}

const brewery = {
  id: 'brewery',
  label: 'Breweries',
  short: 'breweries',
  tag: 'brewery',
  finderVersion: 1,
  overpassSelectors: breweryOverpassSelectors,
  isQualityLead: breweryIsQualityLead,
  isBigChain: breweryIsBigChain,
};

// ── SMOKE / VAPE / BODEGAS (independent neighborhood retail) ──────────────────
// The "marijuana-adjacent, community-vibe" tier the owner asked for AFTER
// dispensaries: independent corner stores/bodegas (shop=convenience), smoke shops
// (shop=tobacco), and vape shops (shop=e-cigarette / shop=vape). The hard part is
// EXCLUDING the chains and gas-station c-stores — done with OSM's brand:wikidata
// signal, a fuel guard, and a chain name-blocklist. This vertical is inherently
// noisier than dispensaries/breweries (bodegas are sparsely, inconsistently
// mapped), so it's opt-in per campaign, never the default.
const SMOKE_OVERPASS_NAME_RE = 'bodega|smoke ?shop|head ?shop|vape|vapor|hookah|shisha|tobacco|cigar|mini ?mart|mini ?market|corner ?(store|market|deli)|food ?mart|supermercado|mercado';
const SMOKE_NAME = /\b(bodega|smoke ?shop|head ?shop|vape|vapor|vaping|e-?cig|hookah|shisha|tobacco|cigar|mini ?mart|mini ?market|corner ?(store|market|deli)|food ?mart|supermercado|mercado)\b/i;
// Not an independent storefront we'd want: pharmacies, gas/fuel, ATMs/vending/kiosks.
const SMOKE_JUNK = /pharmac|\bgas\b|\bfuel\b|petro(l|leum)?\b|gas ?station|\batm\b|vending|kiosk|car ?wash/i;
// Convenience / tobacco / vape CHAINS + fuel brands + big-box (behind the
// brand:wikidata gate, for the un-branded stragglers). Distinctive tokens only.
const SMOKE_CHAINS = /\b(7[\s-]?eleven|seven eleven|circle k|speedway|casey'?s|wawa|sheetz|quiktrip|\bqt\b|kwik ?trip|kwik ?star|cumberland farms|racetrac|raceway|kum ?& ?go|maverik|murphy (usa|express)|pilot|flying j|love'?s|getgo|turkey hill|rutter'?s|stewart'?s|holiday|quickchek|thorntons|ampm|am\/pm|arco|stripes|allsup'?s|on the run|oncue|shell|exxon|mobil|chevron|\bbp\b|marathon|sunoco|citgo|valero|phillips 66|conoco|\b76\b|gulf|texaco|smoker friendly|discount tobacco|tobacco outlet|tobacco superstore|cigars international|vaporfi|madvapes|vapor world|cvs|walgreens|rite aid|dollar (general|tree)|family dollar|walmart|target|costco|sam'?s club)\b/i;

function isSmokeChain(tags = {}, name = '') {
  if (hasBrandWikidata(tags)) return true;
  return SMOKE_CHAINS.test(`${tags.brand || ''} ${tags.operator || ''} ${name}`);
}
// A good independent smoke/vape/bodega lead? Closed / gas-station / chain are out.
// A trusted independent shop tag (tobacco / e-cigarette / vape / convenience /
// grocery) → yes. Otherwise a name-net hit must carry a real bodega/smoke token
// AND not match the junk gate. Pure + unit-tested.
function smokeIsQualityLead(tags = {}, name = '') {
  if (isClosedPoi(tags)) return false;
  if (isFuelStation(tags)) return false;
  if (isSmokeChain(tags, name)) return false;
  const shop = String(tags.shop || '').toLowerCase();
  if (shop === 'tobacco' || shop === 'e-cigarette' || shop === 'vape') return true;
  if ((shop === 'convenience' || shop === 'grocery') && !SMOKE_JUNK.test(name)) return true;
  return SMOKE_NAME.test(name) && !SMOKE_JUNK.test(name);
}
function smokeOverpassSelectors(b) {
  return [
    `  node["shop"="tobacco"][!"brand:wikidata"](${b});`,
    `  way["shop"="tobacco"][!"brand:wikidata"](${b});`,
    `  node["shop"="e-cigarette"][!"brand:wikidata"](${b});`,
    `  way["shop"="e-cigarette"][!"brand:wikidata"](${b});`,
    `  node["shop"="vape"][!"brand:wikidata"](${b});`,
    `  node["shop"="convenience"][!"brand:wikidata"]["amenity"!~"fuel"](${b});`,
    `  way["shop"="convenience"][!"brand:wikidata"]["amenity"!~"fuel"](${b});`,
    `  node["name"~"${SMOKE_OVERPASS_NAME_RE}",i](${b});`,
    `  way["name"~"${SMOKE_OVERPASS_NAME_RE}",i](${b});`,
  ].join('\n');
}

const smokeVape = {
  id: 'smoke-vape',
  label: 'Smoke, Vape & Bodegas',
  short: 'smoke/vape shops',
  tag: 'smoke-vape',
  finderVersion: 1,
  experimental: true, // sparsely mapped on OSM — opt-in, never the default
  overpassSelectors: smokeOverpassSelectors,
  isQualityLead: smokeIsQualityLead,
  isBigChain: isSmokeChain,
};

// ── Registry ─────────────────────────────────────────────────────────────────
const VERTICALS = { dispensary, brewery, 'smoke-vape': smokeVape };
const VERTICAL_IDS = Object.keys(VERTICALS);
const DEFAULT_VERTICAL_ID = 'dispensary';
const NON_DEFAULT_VERTICAL_IDS = VERTICAL_IDS.filter((id) => id !== DEFAULT_VERTICAL_ID);
// Every non-default vertical's CRM tag. The default (dispensary) is the CATCH-ALL:
// its enrollable pool is "cold leads NOT claimed by another vertical", so adding
// breweries never removes a lead from the existing dispensary campaign.
const NON_DEFAULT_VERTICAL_TAGS = VERTICAL_IDS
  .filter((id) => id !== DEFAULT_VERTICAL_ID)
  .map((id) => VERTICALS[id].tag);

// Resolve a vertical id (or unknown/empty) to its definition, defaulting to
// dispensary. Pure.
function getVertical(id) {
  return VERTICALS[id] || VERTICALS[DEFAULT_VERTICAL_ID];
}
function isVertical(id) {
  return Object.prototype.hasOwnProperty.call(VERTICALS, id);
}

// Each vertical sweeps the national rollout on its OWN frontier, so the finder
// state is keyed per vertical. Dispensary keeps the original 'frontier' key (no
// migration — the existing state doc keeps driving the dispensary sweep); others
// get 'frontier:<id>'. Pure.
function frontierStateKey(id) {
  const vid = isVertical(id) ? id : DEFAULT_VERTICAL_ID;
  return vid === DEFAULT_VERTICAL_ID ? 'frontier' : `frontier:${vid}`;
}

// The Mongo filter fragment that scopes a campaign's enrollable pool to its
// vertical. A non-default vertical draws ONLY from its own tag; the default draws
// from everything NOT tagged for another vertical (so it stays the catch-all and
// the existing dispensary campaign's pool is unchanged). Pure — returns a plain
// object to spread into a Client query.
function verticalPoolFilter(id) {
  const vid = isVertical(id) ? id : DEFAULT_VERTICAL_ID;
  if (vid === DEFAULT_VERTICAL_ID) {
    return NON_DEFAULT_VERTICAL_TAGS.length ? { tags: { $nin: NON_DEFAULT_VERTICAL_TAGS } } : {};
  }
  return { tags: VERTICALS[vid].tag };
}

// A Mongo match fragment selecting the LeadFinderRun rows for a vertical. The
// default (dispensary) also matches LEGACY rows written before the `vertical`
// field existed (their value is absent, not 'dispensary'), so the dispensary
// frontier + coverage map never lose their history. `$nin` matches absent values.
// Pure — a plain object, no mongoose dependency.
function verticalRunMatch(id) {
  const vid = isVertical(id) ? id : DEFAULT_VERTICAL_ID;
  return vid === DEFAULT_VERTICAL_ID
    ? { vertical: { $nin: NON_DEFAULT_VERTICAL_IDS } }
    : { vertical: vid };
}

// The public list the Studio's campaign editor renders (id + label + flags). Kept
// small; the frontend mirrors these ids/labels (commented as a mirror).
function verticalOptions() {
  return VERTICAL_IDS.map((id) => ({
    id,
    label: VERTICALS[id].label,
    short: VERTICALS[id].short,
    experimental: !!VERTICALS[id].experimental,
    isDefault: id === DEFAULT_VERTICAL_ID,
  }));
}

module.exports = {
  VERTICALS,
  VERTICAL_IDS,
  DEFAULT_VERTICAL_ID,
  NON_DEFAULT_VERTICAL_IDS,
  NON_DEFAULT_VERTICAL_TAGS,
  getVertical,
  isVertical,
  frontierStateKey,
  verticalPoolFilter,
  verticalRunMatch,
  verticalOptions,
  // pure gates — unit-tested
  breweryIsQualityLead,
  breweryIsBigChain,
  hasBreweryTag,
  isMacroBrewery,
  smokeIsQualityLead,
  isSmokeChain,
  isFuelStation,
};
