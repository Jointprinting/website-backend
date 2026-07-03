// controllers/__tests__/dispensarySuggest.test.js
//
// Unit tests for the pure run-suggestion ranker (controllers/dispensary.js).
// No DB: covers distance, radius filtering, skipping customers/dead leads, the
// prospect scoring order, and the cap.

const test = require('node:test');
const assert = require('node:assert');

const { rankProspects, haversineMi } = require('../dispensary');

test('haversineMi ≈ real miles (0 for same point, ~69mi per degree of latitude)', () => {
  assert.strictEqual(haversineMi(39.9, -74.9, 39.9, -74.9), 0);
  const oneDeg = haversineMi(39.9, -74.9, 40.9, -74.9);
  assert.ok(oneDeg > 68 && oneDeg < 70, `expected ~69, got ${oneDeg}`);
});

test('rankProspects filters radius + customers/dead, scores fresh+phone first, caps', () => {
  const origin = { lat: 39.9, lng: -74.9 };
  const mi = (n) => 39.9 + n / 69; // n miles north of origin
  const docs = [
    { _id: 'A', name: 'A', lat: mi(2),  lng: -74.9, phone: '555', companyKey: 'a' },              // fresh+phone = 3, 2mi
    { _id: 'B', name: 'B', lat: mi(1),  lng: -74.9, phone: '',    companyKey: 'b' },              // fresh, no phone = 2, 1mi
    { _id: 'C', name: 'C', lat: mi(0.5),lng: -74.9, phone: '555', companyKey: 'c' },              // warm+phone = 1, 0.5mi
    { _id: 'D', name: 'D', lat: mi(0.5),lng: -74.9, phone: '555', companyKey: 'd' },              // customer → skipped
    { _id: 'E', name: 'E', lat: mi(50), lng: -74.9, phone: '555', companyKey: 'e' },              // 50mi → out of radius
    { _id: 'F', name: 'F', lat: null,   lng: null,  phone: '555', companyKey: 'f' },              // no coords → skipped
  ];
  const stageByKey = new Map([['c', 'contacted'], ['d', 'customer']]);
  const out = rankProspects(docs, origin, { radiusMi: 25, stageByKey, limit: 10 });
  assert.deepStrictEqual(out.map((s) => s._id), ['A', 'B', 'C']); // score 3, 2, 1; D/E/F excluded
  assert.strictEqual(out[0].fresh, true);
  assert.strictEqual(out[0].score, 3);
  assert.strictEqual(out[2].stage, 'contacted');
});

test('rankProspects breaks score ties by nearest, and honors the limit', () => {
  const origin = { lat: 39.9, lng: -74.9 };
  const mi = (n) => 39.9 + n / 69;
  const docs = [
    { _id: 'far',  name: 'far',  lat: mi(6), lng: -74.9, phone: '5', companyKey: 'x' }, // score 3, 6mi
    { _id: 'near', name: 'near', lat: mi(2), lng: -74.9, phone: '5', companyKey: 'y' }, // score 3, 2mi
    { _id: 'mid',  name: 'mid',  lat: mi(4), lng: -74.9, phone: '5', companyKey: 'z' }, // score 3, 4mi
  ];
  const out = rankProspects(docs, origin, { radiusMi: 25, stageByKey: new Map(), limit: 2 });
  assert.deepStrictEqual(out.map((s) => s._id), ['near', 'mid']); // nearest first, capped at 2
});
