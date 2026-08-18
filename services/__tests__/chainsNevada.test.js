// services/__tests__/chainsNevada.test.js
//
// The owner drove to Las Vegas, opened the Field Map, and saw far fewer
// dispensaries than Clark County actually has. The map hides chains by default,
// and three separate defects in this module were manufacturing chains that
// don't exist — in a metro, at exactly the density where it matters most.
//
//   node --test services/__tests__/chainsNevada.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { assignChains, detectKnownChain, brandBase, CHAIN_MIN_LOCATIONS } = require('../dispensaryChains');

// ── 1. The city is not a brand ───────────────────────────────────────────────

test('generically-named shops in one city are not fused into a fake chain', () => {
  // Every noise word gets stripped ('dispensary', 'cannabis', 'marijuana',
  // 'medical', 'the', 'company') and the state list covers 'nevada' — so the
  // only surviving token used to be the CITY, and these three unrelated
  // businesses all became the brand "las vegas".
  const rows = [
    { name: 'The Dispensary Las Vegas', city: 'Las Vegas', companyKey: 'a' },
    { name: 'Las Vegas Cannabis Company', city: 'Las Vegas', companyKey: 'b' },
    { name: 'Las Vegas Medical Marijuana Dispensary', city: 'Las Vegas', companyKey: 'c' },
  ];
  assert.equal(assignChains(rows).size, 0, 'three unrelated shops must stay independent');
});

test('brandBase strips the row own city', () => {
  assert.equal(brandBase('Las Vegas Cannabis Company', 'Las Vegas'), '');
  // ...and a real brand in that city survives intact.
  assert.equal(brandBase('Jardin Premium Cannabis', 'Las Vegas'), 'jardin premium');
});

test('a real multi-location brand is still caught', () => {
  const rows = [
    { name: 'Jardin Premium Cannabis', city: 'Las Vegas', companyKey: 'j1' },
    { name: 'Jardin Premium Cannabis', city: 'Henderson', companyKey: 'j2' },
    { name: 'Jardin Premium Cannabis', city: 'Reno', companyKey: 'j3' },
  ];
  assert.equal(assignChains(rows).size, 3, 'three real locations is a chain');
});

// ── 2. Licences are not storefronts ──────────────────────────────────────────

test('a store holding two licences counts once', () => {
  // Nevada issues medical and adult-use certificates separately, so one shop
  // can arrive as two rows. Counting ROWS doubled every operator and pushed
  // two-location businesses over the three-location bar.
  const rows = [
    { name: 'Thrive Cannabis Marketplace', city: 'Las Vegas', companyKey: 't1' },
    { name: 'Thrive Cannabis Marketplace', city: 'Las Vegas', companyKey: 't1' },
    { name: 'Thrive Cannabis Marketplace', city: 'Reno', companyKey: 't2' },
    { name: 'Thrive Cannabis Marketplace', city: 'Reno', companyKey: 't2' },
  ];
  assert.equal(rows.length, 4);
  assert.equal(assignChains(rows).size, 0, 'four rows, two real storefronts — under the bar');
});

test('distinct addresses still count as distinct storefronts without a companyKey', () => {
  const rows = [
    { name: 'Silver Sage Wellness', city: 'Las Vegas', address: '4626 W Charleston Blvd' },
    { name: 'Silver Sage Wellness', city: 'Las Vegas', address: '1350 S Rainbow Blvd' },
    { name: 'Silver Sage Wellness', city: 'Las Vegas', address: '2550 S Rainbow Blvd' },
  ];
  assert.equal(assignChains(rows).size, CHAIN_MIN_LOCATIONS);
});

// ── 3. A brand has to lead the name ──────────────────────────────────────────

test('a national brand matched mid-name does not claim a local operator', () => {
  // Deep Roots Harvest is Nevada-only. The regex for the national MSO 'Harvest'
  // matched the middle of it, so a four-store local business was badged
  // "multi-state chain" — about a company whose owner is across town.
  assert.equal(detectKnownChain('Deep Roots Harvest Dispensary'), null);
});

test('the real national brands are still recognised', () => {
  for (const [name, want] of [
    ['Curaleaf Las Vegas', 'Curaleaf'],
    ['Harvest of Las Vegas', 'Harvest'],
    ['Cookies On The Strip', 'Cookies'],
    // Brands that ARE their article must survive the article-stripping path.
    ['The Botanist Henderson', 'The Botanist (Acreage)'],
    ['The Mint Dispensary', 'The Mint'],
  ]) {
    assert.equal(detectKnownChain(name), want, name);
  }
});

test('Nevada-only operators are not mistaken for national MSOs', () => {
  // These are real Las Vegas operators. None is a national chain, and every one
  // of them is a GOOD merch lead — one owner, several stores, decision-maker in
  // town. They must not be silently filed as corporate.
  for (const name of [
    'Jardin Premium Cannabis', 'Planet 13 Las Vegas', 'Reef Dispensaries',
    'Silver Sage Wellness', 'Oasis Cannabis', 'Thrive Cannabis Marketplace',
    'Deep Roots Harvest',
  ]) {
    assert.equal(detectKnownChain(name), null, name);
  }
});

test('rows carrying no location identity at all are still counted separately', () => {
  // The storefront-dedupe key is built from address+city. An EMPTY address and
  // city still produce the separator "|", which is a non-empty string — so a
  // naive `a || b || fallback` never reaches the fallback and every such row
  // collapses onto one key, silently un-chaining a real brand. With nothing to
  // compare, two rows are two places.
  const rows = [
    { name: 'Green Gruff of Trenton' },
    { name: 'Green Gruff of Camden' },
    { name: 'Green Gruff - Newark' },
  ];
  assert.equal(assignChains(rows).size, 3);
});
