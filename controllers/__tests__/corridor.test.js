// controllers/__tests__/corridor.test.js
// Pure checks for the corridor day planner's polyline prune:
//   node --test controllers/__tests__/corridor.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { corridorPrune } = require('../dispensary');

// A straight ~70mi west→east route along 40.5°N (1° lng ≈ 52.5mi there).
const ROUTE = [
  { lat: 40.5, lng: -75.0 },
  { lat: 40.5, lng: -74.5 },
  { lat: 40.5, lng: -74.0 },
];

test('corridorPrune keeps in-band stores and drops out-of-the-way ones', () => {
  const docs = [
    { _id: 'on', lat: 40.5, lng: -74.5 },        // dead on the route
    { _id: 'near', lat: 40.53, lng: -74.7 },     // ~2mi north — inside a 3mi band
    { _id: 'far', lat: 40.8, lng: -74.5 },       // ~20mi north — out
  ];
  const out = corridorPrune(ROUTE, docs, 3);
  const ids = out.map((r) => r.doc._id);
  assert.ok(ids.includes('on'));
  assert.ok(ids.includes('near'));
  assert.ok(!ids.includes('far'));
});

test('corridorPrune orders survivors by progress along the drive', () => {
  const docs = [
    { _id: 'late', lat: 40.5, lng: -74.1 },
    { _id: 'early', lat: 40.5, lng: -74.9 },
    { _id: 'mid', lat: 40.5, lng: -74.5 },
  ];
  const out = corridorPrune(ROUTE, docs, 3);
  assert.deepEqual(out.map((r) => r.doc._id), ['early', 'mid', 'late']);
  assert.ok(out[0].progress < out[1].progress && out[1].progress < out[2].progress);
});

test('corridorPrune distance is roughly right (perpendicular miles)', () => {
  // 0.1° of latitude ≈ 6.9 miles off the route.
  const docs = [{ _id: 'x', lat: 40.6, lng: -74.5 }];
  const out = corridorPrune(ROUTE, docs, 10);
  assert.equal(out.length, 1);
  assert.ok(Math.abs(out[0].distanceMi - 6.9) < 0.3, `got ${out[0].distanceMi}`);
});

test('corridorPrune handles degenerate inputs', () => {
  assert.deepEqual(corridorPrune([], [{ _id: 'a', lat: 1, lng: 1 }], 3), []);
  assert.deepEqual(corridorPrune([{ lat: 1, lng: 1 }], [{ _id: 'a', lat: 1, lng: 1 }], 3), []);
  assert.deepEqual(corridorPrune(ROUTE, [], 3), []);
});
