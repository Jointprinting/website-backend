// controllers/__tests__/dispensarySegment.test.js
//
// Pure-logic tests for the Field Map's market-segment derivation
// (services/dispensaryStates.deriveSegment). The segment drives the map's
// REC / MED / HEMP clickers; the contract that matters:
//   • rec-state pins are 'rec' regardless of source
//   • medical-only-state pins are 'med' when license/sweep-backed; OSM finds
//     there are 'med' when the find carried a medical/trusted cannabis TAG
//     (opts.medical — a mapper-tagged shop in a med state is a licensee) and
//     'hemp' when it was a name-net-only hit (CBD/hemp storefronts)
//   • a cannabis-tagged shop in a no-marijuana-retail state IS 'hemp'
//   • unparsed states ('US'/'') derive '' and are never segment-filtered
//   • the med states are first-class roster states (ROSTER_STATES) so the
//     ingest can license-load PA instead of refusing it
//
//   node --test controllers/__tests__/dispensarySegment.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveSegment, SEGMENTS, MED_STATES, MEDICAL_ONLY, ROSTER_STATES, REC_STATES,
} = require('../../services/dispensaryStates');

test('rec states derive rec for every source', () => {
  for (const source of ['roster', 'google', 'manual', 'osm']) {
    assert.equal(deriveSegment('NJ', source), 'rec');
    assert.equal(deriveSegment('CA', source), 'rec');
  }
});

test('medical-only states: med for roster/google/manual, hemp for bare osm finds', () => {
  for (const source of ['roster', 'google', 'manual']) {
    assert.equal(deriveSegment('FL', source), 'med');
    assert.equal(deriveSegment('PA', source), 'med');
  }
  assert.equal(deriveSegment('FL', 'osm'), 'hemp');
});

test('medical-only states: an osm find with the medical hint is a MED pin', () => {
  assert.equal(deriveSegment('PA', 'osm', { medical: true }), 'med');
  assert.equal(deriveSegment('FL', 'osm', { medical: true }), 'med');
  // The hint never touches other markets: rec stays rec, no-retail stays hemp.
  assert.equal(deriveSegment('NJ', 'osm', { medical: true }), 'rec');
  assert.equal(deriveSegment('TX', 'osm', { medical: true }), 'hemp');
  // And an explicit false hint matches the bare-osm default.
  assert.equal(deriveSegment('PA', 'osm', { medical: false }), 'hemp');
});

test('med states are roster states: PA is loadable, registries stay disjoint', () => {
  assert.ok(MED_STATES.PA, 'PA must have a roster config');
  assert.ok(ROSTER_STATES.PA && ROSTER_STATES.NJ, 'ROSTER_STATES spans both markets');
  assert.deepEqual(MEDICAL_ONLY, Object.keys(MED_STATES), 'codes list derives from MED_STATES');
  for (const code of Object.keys(MED_STATES)) {
    assert.ok(!REC_STATES[code], `${code} cannot be both rec and med`);
    assert.ok(MED_STATES[code].roster && MED_STATES[code].roster.kind, `${code} needs a roster source`);
  }
});

test('no-marijuana-retail states derive hemp ("bodega THC")', () => {
  for (const st of ['TX', 'NC', 'SC', 'TN', 'GA']) {
    assert.equal(deriveSegment(st, 'osm'), 'hemp');
    assert.equal(deriveSegment(st, 'roster'), 'hemp');
  }
});

test('unknown / unparsed states derive "" (never filtered)', () => {
  assert.equal(deriveSegment('US', 'osm'), '');
  assert.equal(deriveSegment('', 'roster'), '');
  assert.equal(deriveSegment(null, 'google'), '');
  assert.equal(deriveSegment('XYZ', 'osm'), '');
});

test('case-insensitive on the state code', () => {
  assert.equal(deriveSegment('nj', 'roster'), 'rec');
  assert.equal(deriveSegment('tx', 'osm'), 'hemp');
});

test('SEGMENTS lists the clicker vocabulary in order', () => {
  assert.deepEqual(SEGMENTS, ['rec', 'med', 'hemp']);
});
