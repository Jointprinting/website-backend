// controllers/__tests__/dispensaryMapAccuracy.test.js
//
// Pure-logic tests for the Field Map accuracy fixes:
//   • per-tile scan bookkeeping (tilesForBbox/tilesExtent) — the old
//     center-tile-only key silently skipped fringe ground for 30 days
//   • corridor chunking for the one-shot live Overpass fill
//   • the kratom/CBD junk gate (the corridor's "kratom dispensary" bug)
//   • the combined field-map vertical accepting MEDICAL dispensaries the
//     rec-only gate drops (the Philadelphia hole)
//   • med-market roster rows passing the ingest row gate (PA "Dispensary
//     Permit" rows used to be filtered as medical-only)
//
//   node --test controllers/__tests__/dispensaryMapAccuracy.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { tilesForBbox, tilesExtent, corridorChunks } = require('../dispensary');
const { isQualityLead, parseOverpassElements } = require('../../services/dispensaryFinder');
const { fieldMap } = require('../../services/leadVerticals');
const { rowPasses, sniffHeaders } = require('../../services/dispensaryIngest');

// ── Tile bookkeeping ─────────────────────────────────────────────────────────

test('tilesForBbox covers every touched tile, not just the center', () => {
  // A 1.2°×1.2° viewport spanning tile boundaries → 3×3 tiles.
  const tiles = tilesForBbox({ minLat: 40.1, maxLat: 41.3, minLng: -75.4, maxLng: -74.2 });
  assert.equal(tiles.length, 9);
  const keys = tiles.map((t) => t.key);
  assert.ok(keys.includes('40.00_-75.50')); // SW corner tile
  assert.ok(keys.includes('41.00_-74.50')); // NE corner tile
});

test('tilesForBbox: a bbox inside one tile is one tile; grid-edge bbox claims no extra row', () => {
  assert.equal(tilesForBbox({ minLat: 40.1, maxLat: 40.4, minLng: -74.4, maxLng: -74.1 }).length, 1);
  // maxLat/maxLng exactly on a grid line must not claim the next row/column.
  assert.equal(tilesForBbox({ minLat: 40.0, maxLat: 40.5, minLng: -74.5, maxLng: -74.0 }).length, 1);
});

test('tilesExtent is the union bbox of its tiles', () => {
  const tiles = tilesForBbox({ minLat: 40.1, maxLat: 40.6, minLng: -74.6, maxLng: -74.1 });
  const ext = tilesExtent(tiles);
  assert.equal(ext.minLat, 40.0);
  assert.equal(ext.maxLat, 41.0);
  assert.equal(ext.minLng, -75.0);
  assert.equal(ext.maxLng, -74.0);
});

// ── Corridor chunking ────────────────────────────────────────────────────────

const LONG_ROUTE = Array.from({ length: 100 }, (_, i) => ({
  lat: 40.5 + i * 0.005,          // gentle NE diagonal
  lng: -75.0 + i * 0.02,
}));

test('corridorChunks chops a route into padded bboxes covering every point', () => {
  const chunks = corridorChunks(LONG_ROUTE, 3);
  assert.ok(chunks.length >= 6 && chunks.length <= 9, `got ${chunks.length}`);
  for (const p of LONG_ROUTE) {
    const inside = chunks.some(([s, w, n, e]) => p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e);
    assert.ok(inside, `point ${p.lat},${p.lng} escaped every chunk`);
  }
  // Padding: each bbox must extend beyond its raw points by ~the band width.
  const [s, w] = chunks[0];
  assert.ok(s < LONG_ROUTE[0].lat - 0.03 && w < LONG_ROUTE[0].lng - 0.03);
});

test('corridorChunks handles degenerate input', () => {
  assert.deepEqual(corridorChunks([], 3), []);
  assert.deepEqual(corridorChunks([{ lat: 40, lng: -75 }], 3), []);
  assert.equal(corridorChunks([{ lat: 40, lng: -75 }, { lat: 40.1, lng: -74.9 }], 3).length, 1);
});

// ── Kratom / CBD junk gate ───────────────────────────────────────────────────

test('kratom and CBD-only storefronts no longer pass the name-net', () => {
  // The corridor bug: name-net hit via "dispensar", nothing junk-gated it.
  assert.equal(isQualityLead({}, 'Philly Kratom Dispensary'), false);
  assert.equal(isQualityLead({}, 'CBD Kratom'), false);
  assert.equal(isQualityLead({}, 'Kava Kush Lounge'), false);
  assert.equal(isQualityLead({}, 'CBD Store of Cherry Hill'), false);
  // Real rec names still pass.
  assert.equal(isQualityLead({}, 'Garden State Dispensary'), true);
  assert.equal(isQualityLead({}, 'Kush Korner 420'), true);
  // And a genuinely tagged shop is still trusted regardless of name.
  assert.equal(isQualityLead({ shop: 'cannabis' }, 'Some Odd Name'), true);
});

// ── Combined field-map vertical (rec + medical) ──────────────────────────────

test('field-map vertical accepts medical-only shops the rec gate drops', () => {
  const medTags = { shop: 'cannabis', 'cannabis:medical': 'yes' };  // no rec tag
  assert.equal(isQualityLead(medTags, 'Restore Philadelphia'), false, 'rec gate drops it');
  assert.equal(fieldMap.isQualityLead(medTags, 'Restore Philadelphia'), true, 'map gate keeps it');
  // Rec shops and closed POIs behave as before.
  assert.equal(fieldMap.isQualityLead({ shop: 'cannabis' }, 'Rec Shop'), true);
  assert.equal(fieldMap.isQualityLead({ shop: 'cannabis', 'disused:shop': 'yes' }, 'Gone'), false);
});

test('field-map selectors include the cannabis:medical net', () => {
  const block = fieldMap.overpassSelectors('1,2,3,4');
  assert.ok(/cannabis:medical/.test(block));
  assert.ok(/shop"="cannabis/.test(block));
});

test('parseOverpassElements stamps medical/taggedCannabis hints', () => {
  const json = {
    elements: [
      { type: 'node', id: 1, lat: 39.95, lon: -75.16, tags: { name: 'Med Store', shop: 'cannabis', 'cannabis:medical': 'yes' } },
      { type: 'node', id: 2, lat: 39.96, lon: -75.17, tags: { name: 'Rec Dispensary', shop: 'cannabis' } },
    ],
  };
  const out = parseOverpassElements(json, fieldMap);
  const med = out.find((c) => c.name === 'Med Store');
  const rec = out.find((c) => c.name === 'Rec Dispensary');
  assert.equal(med.medical, true);
  assert.equal(med.taggedCannabis, true);
  assert.equal(rec.medical, false);
  assert.equal(rec.taggedCannabis, true);
});

// ── Med-market roster row gate ───────────────────────────────────────────────

const PA_MAP = sniffHeaders(['permit_number', 'license_type', 'status', 'business_name', 'address', 'city', 'zip']);

test('medical-market rows pass the gate that used to refuse them', () => {
  const mk = (type, status = 'Active') => ({
    license_type: type, status, business_name: 'Keystone Wellness', address: '1 Broad St', city: 'Philadelphia', zip: '19104',
  });
  assert.equal(rowPasses(mk('Medical Marijuana Dispensary'), PA_MAP, null, { medicalMarket: true }), true);
  assert.equal(rowPasses(mk('Dispensary Permit'), PA_MAP, null, { medicalMarket: true }), true);
  assert.equal(rowPasses(mk('Medical Marijuana Treatment Center'), PA_MAP, null, { medicalMarket: true }), true);
  // Non-retail classes still fail, dead licenses still fail.
  assert.equal(rowPasses(mk('Grower/Processor'), PA_MAP, null, { medicalMarket: true }), false);
  assert.equal(rowPasses(mk('Dispensary Permit', 'Revoked'), PA_MAP, null, { medicalMarket: true }), false);
  // And the rec-market behavior is unchanged: medical-only types stay out.
  assert.equal(rowPasses(mk('Medical Dispensary'), PA_MAP, null), false);
});

// ── Exhaustive-search layers: roster fallback chain + Google gap-fill gates ───

const { rosterAttempts, rowMatchesState } = require('../../services/dispensaryIngest');
const { shouldGapFill } = require('../dispensary');
const { ROSTER_STATES } = require('../../services/dispensaryStates');

test('rosterAttempts: every loadable state ends at the all-states aggregate', () => {
  const oh = rosterAttempts(ROSTER_STATES.OH, 'OH');
  assert.equal(oh[0].kind, 'cannlytics');                    // per-state first
  assert.equal(oh[oh.length - 1].kind, 'cannlytics-all');    // aggregate last
  const ny = rosterAttempts(ROSTER_STATES.NY, 'NY');
  assert.deepEqual(ny.map((a) => a.kind), ['socrata', 'cannlytics', 'cannlytics-all']);
  // An explicit override is trusted alone.
  assert.equal(rosterAttempts(ROSTER_STATES.OH, 'OH', 'https://x.example/r.csv').length, 1);
});

test('rowMatchesState: code or full name, and no state column means no match', () => {
  const map = { state: 'premise_state' };
  assert.equal(rowMatchesState({ premise_state: 'OH' }, map, 'OH', 'Ohio'), true);
  assert.equal(rowMatchesState({ premise_state: 'ohio' }, map, 'OH', 'Ohio'), true);
  assert.equal(rowMatchesState({ premise_state: 'MI' }, map, 'OH', 'Ohio'), false);
  assert.equal(rowMatchesState({ premise_state: '' }, map, 'OH', 'Ohio'), false);
  assert.equal(rowMatchesState({ premise_state: 'OH' }, {}, 'OH', 'Ohio'), false);
});

test('shouldGapFill: fires only for a thin metro view with budget + key + stale tile', () => {
  const ok = { span: 0.4, dbCount: 3, keySet: true, disabled: false, dailyUsed: 2, cap: 15, tileFresh: false };
  assert.equal(shouldGapFill(ok), true);
  assert.equal(shouldGapFill({ ...ok, disabled: true }), false);       // kill switch
  assert.equal(shouldGapFill({ ...ok, keySet: false }), false);        // no key, no spend
  assert.equal(shouldGapFill({ ...ok, span: 1.5 }), false);            // zoomed out
  assert.equal(shouldGapFill({ ...ok, dbCount: 40 }), false);          // already dense
  assert.equal(shouldGapFill({ ...ok, dailyUsed: 15 }), false);        // daily cap
  assert.equal(shouldGapFill({ ...ok, tileFresh: true }), false);      // monthly per tile
});
