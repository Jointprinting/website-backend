const test = require('node:test');
const assert = require('node:assert');
const { parseZip, zip3, buildZip3Index, lookupZip } = require('../zipGeo');

test('reads the ZIP out of an address the owner actually types', () => {
  assert.strictEqual(parseZip('655 Ballard Rd. Jackson, MI 49201'), '49201');
  assert.strictEqual(parseZip('Jackson, MI 49201-1234'), '49201');
  assert.strictEqual(parseZip('  49201  '), '49201');
});

test('a street number is not a ZIP — a wrong one is worse than none', () => {
  // It would look precise and quietly move the zone.
  assert.strictEqual(parseZip('12345 Main Street, Toledo OH'), '');
  assert.strictEqual(parseZip(''), '');
  assert.strictEqual(parseZip(null), '');
  assert.strictEqual(parseZip('no digits here'), '');
});

test('the trailing ZIP wins when an address carries several numbers', () => {
  assert.strictEqual(parseZip('Suite 400, 2460 5th Ave S, St. Petersburg, FL 33712'), '33712');
});

test('zip3 is the sectional centre, and tolerates a bare one', () => {
  assert.strictEqual(zip3('49201'), '492');
  assert.strictEqual(zip3('492'), '492');
  assert.strictEqual(zip3('4920'), '');
  assert.strictEqual(zip3(''), '');
  assert.strictEqual(zip3(null), '');
});

test('a sector centroid is the mean of its members', () => {
  const idx = buildZip3Index([
    { zip: '49201', lat: 42.24, lng: -84.40 },
    { zip: '49202', lat: 42.28, lng: -84.42 },
  ]);
  assert.deepStrictEqual(idx['492'], { lat: 42.26, lon: -84.41, n: 2 });
});

test('one shop places its whole sector — including clients who are not dispensaries', () => {
  const idx = buildZip3Index([{ zip: '49201', lat: 42.24, lng: -84.40 }]);
  const hit = lookupZip(idx, '49284');
  assert.ok(hit, 'a different ZIP in the same sector still resolves');
  assert.strictEqual(hit.zip3, '492');
  assert.strictEqual(hit.n, 1, 'and says how thin the evidence is');
});

test('an uncovered sector returns null, so the caller falls back to the state', () => {
  const idx = buildZip3Index([{ zip: '49201', lat: 42.24, lng: -84.40 }]);
  assert.strictEqual(lookupZip(idx, '90210'), null);
  assert.strictEqual(lookupZip(idx, ''), null);
  assert.strictEqual(lookupZip(null, '49201'), null);
});

test('junk coordinates are dropped, never averaged in', () => {
  // A zeroed or transposed row would drag a sector across the country.
  const idx = buildZip3Index([
    { zip: '49201', lat: 42.24, lng: -84.40 },
    { zip: '49202', lat: 0, lng: 0 },              // unset
    { zip: '49203', lat: -84.4, lng: 42.2 },        // transposed
    { zip: '49204', lat: 'x', lng: 'y' },           // junk
    { zip: '', lat: 42.2, lng: -84.4 },             // no zip
  ]);
  assert.deepStrictEqual(idx['492'], { lat: 42.24, lon: -84.4, n: 1 });
});

test('accepts either lng or lon, and latitude/longitude spellings', () => {
  const idx = buildZip3Index([
    { zip: '10001', lat: 40.75, lon: -73.99 },
    { zip: '10002', latitude: 40.71, longitude: -73.98 },
  ]);
  assert.strictEqual(idx['100'].n, 2);
});

test('empty input is safe', () => {
  assert.deepStrictEqual(buildZip3Index([]), {});
  assert.deepStrictEqual(buildZip3Index(null), {});
  assert.deepStrictEqual(buildZip3Index([null, undefined]), {});
});
