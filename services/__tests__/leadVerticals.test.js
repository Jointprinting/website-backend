// services/__tests__/leadVerticals.test.js
//
// Pure-logic checks for the multi-vertical lead finder (no network, no DB):
//   node --test services/__tests__/leadVerticals.test.js
//
// The registry + each vertical's OSM quality/chain gates are pure and exported,
// so the risky bits (what counts as a brewery / bodega, what's a chain to skip)
// are covered here. The dispensary vertical is unchanged and covered by
// leadFinder.test.js; here we prove the NEW verticals + the generic finder param.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  VERTICAL_IDS, DEFAULT_VERTICAL_ID, getVertical, isVertical,
  verticalPoolFilter, verticalRunMatch, frontierStateKey, verticalOptions,
  breweryIsQualityLead, breweryIsBigChain, hasBreweryTag, isMacroBrewery,
  smokeIsQualityLead, isSmokeChain, isFuelStation, VERTICALS,
} = require('../leadVerticals');
const { buildOverpassQuery, parseOverpassElements } = require('../dispensaryFinder');

// ── Registry ─────────────────────────────────────────────────────────────────
test('registry: dispensary is the default; brewery + smoke-vape are present', () => {
  assert.equal(DEFAULT_VERTICAL_ID, 'dispensary');
  assert.deepEqual(VERTICAL_IDS.sort(), ['brewery', 'dispensary', 'smoke-vape']);
  assert.equal(isVertical('brewery'), true);
  assert.equal(isVertical('nope'), false);
  // Unknown / empty resolves to the default (dispensary), never throws.
  assert.equal(getVertical('nope').id, 'dispensary');
  assert.equal(getVertical(undefined).id, 'dispensary');
  assert.equal(getVertical('brewery').id, 'brewery');
});

test('verticalOptions lists every vertical with its default/experimental flags', () => {
  const opts = verticalOptions();
  assert.equal(opts.length, 3);
  const disp = opts.find((o) => o.id === 'dispensary');
  assert.equal(disp.isDefault, true);
  const smoke = opts.find((o) => o.id === 'smoke-vape');
  assert.equal(smoke.experimental, true);
  assert.equal(opts.find((o) => o.id === 'brewery').isDefault, false);
});

test('verticalPoolFilter: default is the catch-all, others draw only their tag', () => {
  // Dispensary (default) = "NOT tagged for another vertical" → existing pool
  // unchanged, so adding breweries never removes a dispensary campaign's leads.
  assert.deepEqual(verticalPoolFilter('dispensary'), { tags: { $nin: ['brewery', 'smoke-vape'] } });
  assert.deepEqual(verticalPoolFilter('brewery'), { tags: 'brewery' });
  assert.deepEqual(verticalPoolFilter('smoke-vape'), { tags: 'smoke-vape' });
  // Unknown → default behavior.
  assert.deepEqual(verticalPoolFilter('nope'), { tags: { $nin: ['brewery', 'smoke-vape'] } });
});

test('verticalRunMatch: dispensary also matches LEGACY (pre-vertical) run rows', () => {
  // $nin matches absent values, so old runs (no vertical field) still count as
  // dispensary coverage — the frontier + map never lose their history.
  assert.deepEqual(verticalRunMatch('dispensary'), { vertical: { $nin: ['brewery', 'smoke-vape'] } });
  assert.deepEqual(verticalRunMatch('brewery'), { vertical: 'brewery' });
});

test('frontierStateKey: dispensary keeps the original key, others are namespaced', () => {
  assert.equal(frontierStateKey('dispensary'), 'frontier');
  assert.equal(frontierStateKey('brewery'), 'frontier:brewery');
  assert.equal(frontierStateKey('smoke-vape'), 'frontier:smoke-vape');
});

// ── Breweries ────────────────────────────────────────────────────────────────
test('brewery quality gate: trusted craft tags in, macro + coffee + closed out', () => {
  // Trusted craft-brewer tags → in (any name).
  assert.equal(breweryIsQualityLead({ craft: 'brewery' }, 'The Corner'), true);
  assert.equal(breweryIsQualityLead({ microbrewery: 'yes', amenity: 'pub' }, 'Third Rail'), true);
  // Name-net catches an untagged brewer.
  assert.equal(breweryIsQualityLead({}, 'Cape May Brewing Company'), true);
  assert.equal(breweryIsQualityLead({}, 'Departed Soles Taproom'), true);
  // Coffee "cold brew / roasters" is the classic false positive — dropped.
  assert.equal(breweryIsQualityLead({}, 'Rook Coffee Roasters'), false);
  assert.equal(breweryIsQualityLead({}, 'Nitro Cold Brew Bar'), false);
  // Macro/industrial plant → not an indie lead.
  assert.equal(breweryIsQualityLead({ industrial: 'brewery' }, 'Budweiser Newark'), false);
  assert.equal(isMacroBrewery({ man_made: 'works', product: 'beer' }), true);
  assert.equal(hasBreweryTag({ industrial: 'brewery' }), false);
  // Closed POI → out even with a craft tag.
  assert.equal(breweryIsQualityLead({ craft: 'brewery', 'disused:shop': 'yes' }, 'Gone Ales'), false);
  // A plain bar with no brewer signal → out.
  assert.equal(breweryIsQualityLead({ amenity: 'bar' }, 'The Sports Pub'), false);
});

test('brewery chain gate: macro / macro-owned brands are skipped', () => {
  assert.equal(breweryIsBigChain({}, 'Goose Island Brewhouse'), true);
  assert.equal(breweryIsBigChain({ brand: 'Coors' }, 'Coors Field Taproom'), true);
  assert.equal(breweryIsBigChain({}, 'Yuengling'), true);
  // A genuine independent isn't a chain.
  assert.equal(breweryIsBigChain({}, 'Icarus Brewing'), false);
});

// ── Smoke / Vape / Bodegas ───────────────────────────────────────────────────
test('smoke-vape quality gate: independent tags in, chains + gas + junk out', () => {
  // Trusted independent shop tags.
  assert.equal(smokeIsQualityLead({ shop: 'tobacco' }, "Ray's Smoke Shop"), true);
  assert.equal(smokeIsQualityLead({ shop: 'e-cigarette' }, 'Cloud9 Vapes'), true);
  assert.equal(smokeIsQualityLead({ shop: 'convenience' }, 'Sunny Bodega'), true);
  // Name-net catches an untagged corner store / smoke shop.
  assert.equal(smokeIsQualityLead({}, 'Avenue Mini Mart'), true);
  assert.equal(smokeIsQualityLead({}, 'Downtown Head Shop'), true);
  // Gas-station c-store → out (amenity=fuel or a fuel:* detail).
  assert.equal(isFuelStation({ amenity: 'fuel' }), true);
  assert.equal(smokeIsQualityLead({ shop: 'convenience', amenity: 'fuel' }, 'Quick Stop'), false);
  // OSM brand:wikidata = a known chain → out.
  assert.equal(smokeIsQualityLead({ shop: 'convenience', 'brand:wikidata': 'Q259340' }, '7-Eleven'), false);
  // Un-branded chain straggler caught by name.
  assert.equal(smokeIsQualityLead({ shop: 'convenience' }, 'Wawa'), false);
  assert.equal(smokeIsQualityLead({ shop: 'convenience' }, 'Circle K'), false);
  // Pharmacy / plain gas name → junk gate.
  assert.equal(smokeIsQualityLead({}, 'CVS Pharmacy'), false);
});

test('isSmokeChain flags brands, operators, and brand:wikidata', () => {
  assert.equal(isSmokeChain({ 'brand:wikidata': 'Q123' }, 'Anything'), true);
  assert.equal(isSmokeChain({ operator: 'Sheetz' }, 'Store #5'), true);
  assert.equal(isSmokeChain({}, 'QuikTrip'), true);
  assert.equal(isSmokeChain({}, "Manny's Corner Deli"), false);
});

// ── Generic finder is retargeted by the vertical ─────────────────────────────
test('buildOverpassQuery(vertical) swaps in the vertical selectors', () => {
  const disp = VERTICALS.dispensary;
  const brew = VERTICALS.brewery;
  const smoke = VERTICALS['smoke-vape'];
  const bbox = [38.85, -75.6, 41.36, -73.88];
  // Default / dispensary path is unchanged (cannabis tags, no brewery tags).
  assert.match(buildOverpassQuery(bbox), /shop"="cannabis"/);
  assert.match(buildOverpassQuery(bbox, disp), /shop"="cannabis"/);
  // Brewery query nets craft=brewery / microbrewery, NOT cannabis.
  const bq = buildOverpassQuery(bbox, brew);
  assert.match(bq, /craft"="brewery"/);
  assert.match(bq, /microbrewery"="yes"/);
  assert.doesNotMatch(bq, /shop"="cannabis"/);
  // Smoke/vape query nets tobacco / e-cigarette / convenience, excludes brands.
  const sq = buildOverpassQuery(bbox, smoke);
  assert.match(sq, /shop"="tobacco"/);
  assert.match(sq, /shop"="e-cigarette"/);
  assert.match(sq, /\[!"brand:wikidata"\]/);
});

test('parseOverpassElements(vertical) applies that vertical gate', () => {
  const brew = VERTICALS.brewery;
  const rows = parseOverpassElements({
    elements: [
      { type: 'node', id: 1, tags: { name: 'Cape May Brewing', craft: 'brewery', 'addr:city': 'Cape May', 'addr:state': 'NJ' } },
      { type: 'node', id: 2, tags: { name: 'Rook Coffee Roasters', 'addr:city': 'Oakhurst' } }, // coffee → dropped
      { type: 'node', id: 3, tags: { name: 'Budweiser Works', industrial: 'brewery' } },          // macro → dropped
      { type: 'node', id: 4, tags: { name: 'Departed Soles Taproom', 'addr:state': 'NJ' } },       // name-net → kept
    ],
  }, brew);
  assert.deepEqual(rows.map((r) => r.name).sort(), ['Cape May Brewing', 'Departed Soles Taproom']);
});
