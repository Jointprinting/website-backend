// controllers/__tests__/dispensaryCoverageAudit.test.js
//
// The national coverage contract for the Field Map. These are the guards that
// would have caught "I drove to Colorado and there were no pins":
//
//   • every pitchable market is SWEEPABLE — a roster state with no region bbox
//     can never be OSM-swept or roster-seeded, so it renders empty forever
//   • every pitchable market is REACHABLE by the always-on rollout
//   • rec and med registries stay disjoint and completely mirrored
//   • stateHealth names WHY a state looks empty (empty vs ungeocoded vs
//     chains-only vs osm-only), because "0 pins" has several very different
//     causes and the map alone can't distinguish them
//   • a sweep-seeded state (kind 'google') still degrades to the aggregate
//     rather than throwing
//
//   node --test controllers/__tests__/dispensaryCoverageAudit.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { stateHealth } = require('../dispensary');
const {
  REC_STATES, MED_STATES, ROSTER_STATES, MEDICAL_ONLY, NO_RETAIL_YET,
} = require('../../services/dispensaryStates');
const { REGIONS, NATIONAL_ROLLOUT } = require('../../services/dispensaryFinder');
const { rosterAttempts } = require('../../services/dispensaryIngest');

// ── Every pitchable market must be sweepable + reachable ─────────────────────

test('every roster state has a region bbox (or it can never be swept)', () => {
  const missing = Object.keys(ROSTER_STATES).filter((s) => !REGIONS[s.toLowerCase()]);
  assert.deepEqual(missing, [], `roster states with no REGIONS bbox: ${missing.join(', ')}`);
});

test('every roster state is in the national rollout frontier', () => {
  const rollout = new Set(NATIONAL_ROLLOUT.map((r) => r.toUpperCase()));
  const missing = Object.keys(ROSTER_STATES).filter((s) => !rollout.has(s));
  assert.deepEqual(missing, [], `roster states absent from NATIONAL_ROLLOUT: ${missing.join(', ')}`);
});

test('the rollout only references regions that exist', () => {
  const bad = NATIONAL_ROLLOUT.filter((id) => !REGIONS[id]);
  assert.deepEqual(bad, [], `rollout ids with no region: ${bad.join(', ')}`);
});

test('rec and med registries are disjoint and fully mirrored into ROSTER_STATES', () => {
  for (const code of Object.keys(REC_STATES)) assert.ok(!MED_STATES[code], `${code} in both registries`);
  const union = [...Object.keys(REC_STATES), ...Object.keys(MED_STATES)].sort();
  assert.deepEqual(Object.keys(ROSTER_STATES).sort(), union);
  assert.deepEqual(MEDICAL_ONLY, Object.keys(MED_STATES));
});

test('a state is never both "no retail yet" and a rostered market', () => {
  for (const st of NO_RETAIL_YET) assert.ok(!ROSTER_STATES[st], `${st} is listed as having no retail AND rostered`);
});

test('every roster state declares an expected market size for the coverage check', () => {
  for (const [code, cfg] of Object.entries(ROSTER_STATES)) {
    assert.ok(cfg.approxRetail > 0, `${code} needs approxRetail`);
    assert.ok(cfg.name, `${code} needs a display name`);
  }
});

// ── stateHealth: naming the failure ──────────────────────────────────────────

test('stateHealth: no rows at all is "empty"', () => {
  assert.equal(stateHealth({}, 650), 'empty');
  assert.equal(stateHealth({ total: 0 }, 650), 'empty');
});

test('stateHealth: rows with no coordinates are "ungeocoded", not empty', () => {
  // The roster landed but geocoding never ran — nothing can render.
  assert.equal(stateHealth({ total: 300, mapped: 0, fromRoster: 300 }, 650), 'ungeocoded');
});

test('stateHealth: an all-MSO state is "chains-only" (data fine, view blank)', () => {
  // Chains are excluded from the map by default, so a healthy roster of only
  // chain stores shows the owner an empty screen. That is NOT missing data.
  assert.equal(
    stateHealth({ total: 400, mapped: 400, independents: 0, chainStores: 400, fromRoster: 400 }, 650),
    'chains-only',
  );
});

test('stateHealth: no license rows means "osm-only" — what a dead roster looks like', () => {
  assert.equal(
    stateHealth({ total: 120, mapped: 120, independents: 90, fromRoster: 0, fromOsm: 120 }, 650),
    'osm-only',
  );
});

test('stateHealth: a rostered state well under market size is "thin"', () => {
  assert.equal(
    stateHealth({ total: 100, mapped: 100, independents: 60, fromRoster: 100 }, 650),
    'thin',
  );
});

test('stateHealth: a healthy state is "ok"', () => {
  assert.equal(
    stateHealth({ total: 600, mapped: 600, independents: 300, fromRoster: 600 }, 650),
    'ok',
  );
  // No expectation configured → size can't condemn it.
  assert.equal(stateHealth({ total: 5, mapped: 5, independents: 5, fromRoster: 5 }, 0), 'ok');
});

// ── Sweep-seeded states still degrade gracefully ─────────────────────────────

test('a kind:"google" state (PR/DE) falls through to the aggregate, never throws', () => {
  const attempts = rosterAttempts(MED_STATES.PR, 'PR');
  assert.ok(attempts.length >= 1);
  // No primary URL to try, but the shared aggregate is still attempted.
  assert.equal(attempts[attempts.length - 1].kind, 'cannlytics-all');
  assert.ok(attempts.every((a) => a.kind !== 'google'));
});

test('an explicit override short-circuits every built-in source', () => {
  const attempts = rosterAttempts(REC_STATES.CO, 'CO', 'https://example.org/co.csv');
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].url, 'https://example.org/co.csv');
  assert.equal(attempts[0].kind, 'csv');
});
