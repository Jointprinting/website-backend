// controllers/__tests__/dispensarySegment.test.js
//
// Pure-logic tests for the Field Map's market-segment derivation
// (services/dispensaryStates.deriveSegment). The segment drives the map's
// REC / MED / HEMP clickers; the contract that matters:
//   • rec-state pins are 'rec' regardless of source
//   • medical-only-state pins are 'med' when license/sweep-backed, but OSM
//     tag-net finds there are 'hemp' (CBD/hemp storefronts, not licensees)
//   • a cannabis-tagged shop in a no-marijuana-retail state IS 'hemp'
//   • unparsed states ('US'/'') derive '' and are never segment-filtered
//
//   node --test controllers/__tests__/dispensarySegment.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { deriveSegment, SEGMENTS } = require('../../services/dispensaryStates');

test('rec states derive rec for every source', () => {
  for (const source of ['roster', 'google', 'manual', 'osm']) {
    assert.equal(deriveSegment('NJ', source), 'rec');
    assert.equal(deriveSegment('CA', source), 'rec');
  }
});

test('medical-only states: med for roster/google/manual, hemp for osm finds', () => {
  for (const source of ['roster', 'google', 'manual']) {
    assert.equal(deriveSegment('FL', source), 'med');
    assert.equal(deriveSegment('PA', source), 'med');
  }
  assert.equal(deriveSegment('FL', 'osm'), 'hemp');
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
