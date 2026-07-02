// services/__tests__/dispensaryField.test.js
//
// Pins the pure logic behind the nationwide Field Map: roster CSV parsing,
// header sniffing (state portals rename columns without notice — the mapper
// must find the right ones by keyword), adult-use-retail row filtering,
// normalization/dedupe identity, chain detection, and the run optimizer.
// No DB, no network:
//
//   node --test services/__tests__/dispensaryField.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCsv, sniffHeaders, normalizeRow, rowPasses, deriveCompanyKey, matchKey,
} = require('../dispensaryIngest');
const { detectKnownChain, brandBase, assignChains } = require('../dispensaryChains');
const { optimizeStopOrder, pathMiles } = require('../routeOptimize');

// ── CSV parsing ──────────────────────────────────────────────────────────────

test('parseCsv: quoted fields, escaped quotes, CRLF', () => {
  const rows = parseCsv('name,address\r\n"Joe""s Store","123 Main St, Suite 4"\r\nPlain,456 Oak\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Joe"s Store');
  assert.equal(rows[0].address, '123 Main St, Suite 4');
  assert.equal(rows[1].address, '456 Oak');
});

test('parseCsv: empty input and trailing blank lines', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.equal(parseCsv('a,b\n1,2\n\n').length, 1);
});

// ── Header sniffing ──────────────────────────────────────────────────────────

test('sniffHeaders: NY-OCM-style socrata columns', () => {
  const map = sniffHeaders([
    'license_number', 'license_type', 'license_status',
    'entity_name', 'dba', 'address_line_1', 'city', 'zip_code',
    'georeference',
  ]);
  assert.equal(map.name, 'dba');
  assert.equal(map.licensee, 'entity_name');
  assert.equal(map.licenseNumber, 'license_number');
  assert.equal(map.licenseType, 'license_type');
  assert.equal(map.address, 'address_line_1');
  assert.equal(map.zip, 'zip_code');
});

test('sniffHeaders: cannlytics-style columns', () => {
  const map = sniffHeaders([
    'license_number', 'license_status', 'license_type',
    'business_legal_name', 'business_dba_name',
    'premise_street_address', 'premise_city', 'premise_zip_code',
    'premise_latitude', 'premise_longitude', 'business_phone', 'business_website',
  ]);
  assert.equal(map.name, 'business_dba_name');
  assert.equal(map.lat, 'premise_latitude');
  assert.equal(map.lng, 'premise_longitude');
  assert.equal(map.phone, 'business_phone');
  assert.equal(map.website, 'business_website');
});

// ── Row filtering ────────────────────────────────────────────────────────────

const NY_MAP = sniffHeaders(['license_number', 'license_type', 'license_status', 'entity_name', 'dba', 'address_line_1', 'city', 'zip_code']);

test('rowPasses: adult-use retail passes, cultivator and medical-only fail', () => {
  const mk = (type, status = 'Active') => ({
    license_type: type, license_status: status, dba: 'X', entity_name: 'X LLC',
  });
  assert.equal(rowPasses(mk('Adult-Use Retail Dispensary'), NY_MAP, null), true);
  assert.equal(rowPasses(mk('Adult-Use Microbusiness'), NY_MAP, null), true);
  assert.equal(rowPasses(mk('Adult-Use Cultivator'), NY_MAP, null), false);
  assert.equal(rowPasses(mk('Cannabis Laboratory'), NY_MAP, null), false);
  assert.equal(rowPasses(mk('Medical Dispensary'), NY_MAP, null), false);
  assert.equal(rowPasses(mk('Adult-Use Retail Dispensary', 'Revoked'), NY_MAP, null), false);
});

test('rowPasses: hybrid (dual med/rec) retail passes; explicit typeFilter wins', () => {
  const row = { license_type: 'Hybrid Retailer', license_status: 'Active', dba: 'X' };
  assert.equal(rowPasses(row, NY_MAP, null), true);
  assert.equal(rowPasses(row, NY_MAP, /retail\s*dispensar|microbusiness/i), false);
});

// ── Normalization / identity ─────────────────────────────────────────────────

test('normalizeRow: license number drives the dedupe key; address is the fallback', () => {
  const map = sniffHeaders(['license_number', 'dba', 'address', 'city']);
  const withLic = normalizeRow({ license_number: 'OCM-RETL-123', dba: 'Happy Leaf', address: '1 Main St', city: 'Albany' }, map, 'NY', 'src');
  assert.equal(withLic.dedupeKey, 'NY|lic:ocm-retl-123');
  assert.equal(withLic.companyKey, 'happyleaf');
  assert.equal(withLic.matchKey, 'happyleaf');
  const noLic = normalizeRow({ license_number: '', dba: 'Happy Leaf', address: '1 Main St', city: 'Albany' }, map, 'NY', 'src');
  assert.match(noLic.dedupeKey, /^NY\|addr:happyleaf\|/);
  assert.equal(normalizeRow({ license_number: 'x', dba: '', address: '' }, map, 'NY', 'src'), null);
});

test('companyKey/matchKey mirror the CRM derivations', () => {
  assert.equal(deriveCompanyKey("Joe's Store, LLC"), 'joesstorellc');
  assert.equal(matchKey("Joe's Store, LLC"), 'joesstore'); // corp suffix stripped
});

// ── Chain detection ──────────────────────────────────────────────────────────

test('detectKnownChain: national brands match loosely-qualified names', () => {
  assert.equal(detectKnownChain('Curaleaf NJ Bellmawr'), 'Curaleaf');
  assert.equal(detectKnownChain('RISE Medical and Adult Use Dispensary Paterson'), 'RISE (GTI)');
  assert.equal(detectKnownChain('STIIIZY Union Square'), 'STIIIZY');
  assert.equal(detectKnownChain('Mom & Pop Cannabis Shop'), null);
});

test('brandBase: strips location tails, states, and category noise', () => {
  assert.equal(brandBase('Ascend - Rochelle Park'), 'ascend');
  assert.equal(brandBase('Green Gruff of Trenton'), 'green gruff');
  assert.equal(brandBase('Happy Days Cannabis Dispensary New Jersey LLC'), 'happy days');
});

test('assignChains: ≥3 same-base stores become a chain; one-offs stay solo', () => {
  const rows = [
    { name: 'Green Gruff of Trenton' },
    { name: 'Green Gruff of Camden' },
    { name: 'Green Gruff - Newark' },
    { name: 'Solo Buds' },
    { name: 'Curaleaf Bellmawr' }, // known brand — matched by regex, not family size
  ];
  const chains = assignChains(rows);
  assert.equal(chains.get(0), 'Green Gruff');
  assert.equal(chains.get(1), 'Green Gruff');
  assert.equal(chains.get(2), 'Green Gruff');
  assert.equal(chains.has(3), false);
  assert.equal(chains.get(4), 'Curaleaf');
});

// ── Run optimizer ────────────────────────────────────────────────────────────

test('optimizeStopOrder: orders a north-south line correctly from the south end', () => {
  const start = { lat: 39.0, lng: -74.9 };
  const stops = [
    { lat: 40.5, lng: -74.9 }, // farthest
    { lat: 39.5, lng: -74.9 }, // nearest
    { lat: 40.0, lng: -74.9 }, // middle
  ];
  const { order } = optimizeStopOrder(start, stops);
  assert.deepEqual(order, [1, 2, 0]);
});

test('optimizeStopOrder: 2-opt beats or ties a bad naive path', () => {
  const start = { lat: 40.0, lng: -75.0 };
  // A ring of stops deliberately listed in a zig-zag order.
  const stops = [
    { lat: 40.30, lng: -75.00 },
    { lat: 40.05, lng: -74.70 },
    { lat: 40.20, lng: -74.95 },
    { lat: 40.02, lng: -74.90 },
    { lat: 40.28, lng: -74.75 },
    { lat: 40.10, lng: -74.80 },
  ];
  const { order, miles } = optimizeStopOrder(start, stops);
  const naive = pathMiles(start, stops);
  assert.ok(miles <= naive + 1e-9, `optimized ${miles} should be <= naive ${naive}`);
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]); // a real permutation
});

test('optimizeStopOrder: degenerate sizes', () => {
  assert.deepEqual(optimizeStopOrder({ lat: 0, lng: 0 }, []).order, []);
  assert.deepEqual(optimizeStopOrder({ lat: 0, lng: 0 }, [{ lat: 1, lng: 1 }]).order, [0]);
});
