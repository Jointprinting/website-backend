// controllers/__tests__/dispensaryScanOsm.test.js
//
// Pure-logic tests for the free OSM viewport scan helpers (controllers/
// dispensary.js). No DB / no network: tile-key snapping, the zoom (bbox-span)
// gate, and best-effort state parsing.

const test = require('node:test');
const assert = require('node:assert');

const { tileKeyFor, bboxTooLarge, stateFromAddress } = require('../dispensary');

test('tileKeyFor snaps a point to its 0.5° tile SW corner (stable string)', () => {
  // 40.73,-74.17 → tile [40.5, -74.5]
  assert.strictEqual(tileKeyFor(40.73, -74.17), '40.50_-74.50');
  // A nearby point in the SAME tile yields the SAME key (no re-scan).
  assert.strictEqual(tileKeyFor(40.99, -74.51), '40.50_-75.00');
  assert.strictEqual(tileKeyFor(40.5, -74.5), '40.50_-74.50'); // on the corner
});

test('tileKeyFor: two points one tile apart get different keys', () => {
  assert.notStrictEqual(tileKeyFor(40.4, -74.4), tileKeyFor(40.9, -74.4));
});

test('bboxTooLarge gates a whole-region viewport but passes a street-level one', () => {
  // ~0.3° span — a normal browsing zoom, allowed.
  assert.strictEqual(bboxTooLarge({ minLat: 40.6, maxLat: 40.9, minLng: -74.3, maxLng: -74.0 }), false);
  // ~5° span — zoomed way out, blocked.
  assert.strictEqual(bboxTooLarge({ minLat: 38, maxLat: 43, minLng: -76, maxLng: -71 }), true);
  // A wide LONGITUDE span alone still trips the gate.
  assert.strictEqual(bboxTooLarge({ minLat: 40.6, maxLat: 40.7, minLng: -77, maxLng: -73 }), true);
});

test('stateFromAddress pulls the 2-letter state, falls back to US', () => {
  assert.strictEqual(stateFromAddress('12 High St, Trenton NJ 08601'), 'NJ');
  assert.strictEqual(stateFromAddress('5 Main St, Egg Harbor Township NJ'), 'NJ'); // no zip, trailing ST
  assert.strictEqual(stateFromAddress('Denver CO 80202'), 'CO');
  assert.strictEqual(stateFromAddress('somewhere with no state'), 'US');
  assert.strictEqual(stateFromAddress(''), 'US');
});
