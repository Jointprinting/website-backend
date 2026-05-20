// services/__tests__/jpw.test.js
//
// Tests for the JP Webworks scoring + dedupe engine. Runs on Node's built-in
// test runner — no extra dev deps:
//
//   node --test services/__tests__/jpw.test.js
//
// We mock-free here: all the things under test are pure functions taking
// POJOs.

const test = require('node:test');
const assert = require('node:assert/strict');

const { scoreLead, isCallTodayWorthy } = require('../jpwScoring');
const {
  normalizePhone, normalizeDomain, normalizeName,
  namesProbablyMatch, buildDedupeKeys, buildDedupeFilter,
} = require('../jpwDedupe');
const { guessCategory, gradeFor, categoryMeta } = require('../jpwConstants');

// ── Dedupe ────────────────────────────────────────────────────────────────
test('normalizePhone strips formatting and country code', () => {
  assert.equal(normalizePhone('(609) 555-1234'),  '6095551234');
  assert.equal(normalizePhone('+1 609.555.1234'), '6095551234');
  assert.equal(normalizePhone('609-555-1234'),    '6095551234');
  assert.equal(normalizePhone('1234'),            ''); // not 10 digits → empty
  assert.equal(normalizePhone(''),                '');
  assert.equal(normalizePhone(null),              '');
});

test('normalizeDomain handles bare/www/protocol/path', () => {
  assert.equal(normalizeDomain('https://www.example.com/foo'), 'example.com');
  assert.equal(normalizeDomain('http://Example.COM'),          'example.com');
  assert.equal(normalizeDomain('example.com'),                 'example.com');
  assert.equal(normalizeDomain(''),                            '');
  assert.equal(normalizeDomain('not a url'),                   '');
});

test('normalizeName strips company suffixes and punctuation', () => {
  assert.equal(normalizeName("Joe's Plumbing, LLC"), 'joes plumbing');
  assert.equal(normalizeName('The Acme Co.'),         'acme');
  assert.equal(normalizeName('South Jersey Roofing Inc.'), 'roofing');
});

test('namesProbablyMatch handles minor variation but not different services', () => {
  assert.equal(namesProbablyMatch("Joe's Plumbing LLC",  'Joes Plumbing'),         true);
  assert.equal(namesProbablyMatch('Acme Tree Service',   'Acme Tree Services'),    true);
  assert.equal(namesProbablyMatch('Acme Tree Service',   'Acme Plumbing'),         false);
  assert.equal(namesProbablyMatch('Smith Roofing',       'Smith Brothers Roofing'), false); // big addition
});

test('buildDedupeFilter emits $or only over present keys', () => {
  const f = buildDedupeFilter({
    google_place_id: 'abc', normalized_phone: '', domain: 'ex.com',
    normalized_name: 'joes plumbing', normalized_city: 'voorhees',
  });
  assert.equal(f.$or.length, 3); // place_id, domain, name+city
  const empty = buildDedupeFilter({
    google_place_id: '', normalized_phone: '', domain: '',
    normalized_name: '', normalized_city: '',
  });
  assert.equal(empty, null);
});

test('buildDedupeKeys derives all keys from raw input', () => {
  const k = buildDedupeKeys({
    business_name: "Joe's Plumbing LLC", phone: '(609) 555-1234',
    website_url: 'https://www.joesplumbing.com/contact', city: 'Voorhees',
  });
  assert.equal(k.normalized_name,  'joes plumbing');
  assert.equal(k.normalized_phone, '6095551234');
  assert.equal(k.domain,           'joesplumbing.com');
  assert.equal(k.normalized_city,  'voorhees');
});

// ── Scoring ───────────────────────────────────────────────────────────────
test('Score breakdown exposes per-bucket reasons for UI display', () => {
  const lead = {
    business_name: 'Acme Tree Service',
    phone: '6095551234', normalized_phone: '6095551234',
    website_url: 'https://acmetree.com',
    category: 'Tree Service', county: 'Camden', state: 'NJ',
    rating: 4.7, review_count: 87,
    ad_signal: { active_ads_found: true, active_ad_count: 3 },
    website_audit: { has_click_to_call: false, has_quote_cta: false },
  };
  const s = scoreLead(lead);
  // Each bucket is now { value, reasons[] } not a bare number
  for (const bucket of ['buyingIntent', 'pain', 'abilityToPay', 'fit', 'urgency']) {
    assert.ok(typeof s.breakdown[bucket].value === 'number',
      `${bucket}.value should be a number`);
    assert.ok(Array.isArray(s.breakdown[bucket].reasons),
      `${bucket}.reasons should be an array`);
  }
  // High-ticket lead with ads should have non-empty reasons in both
  // buyingIntent and abilityToPay
  assert.ok(s.breakdown.buyingIntent.reasons.length > 0);
  assert.ok(s.breakdown.abilityToPay.reasons.length > 0);
});

test('A+ lead: high-ticket + ads + reviews + weak conversion', () => {
  const lead = {
    business_name: 'Acme Tree Service',
    phone: '6095551234', normalized_phone: '6095551234',
    website_url: 'https://acmetree.com',
    category: 'Tree Service', county: 'Camden', state: 'NJ',
    rating: 4.7, review_count: 87,
    ad_signal: { active_ads_found: true, active_ad_count: 3, ad_text_samples: ['Free estimate call now'] },
    website_audit: { has_click_to_call: false, has_quote_cta: false, has_localbusiness_schema: false, loads_successfully: true },
  };
  const s = scoreLead(lead);
  assert.ok(s.score >= 80, `expected ≥80, got ${s.score}`);
  assert.equal(s.grade, 'A+');
  assert.equal(s.recommendedOffer, 'Full Growth System');
  assert.ok(isCallTodayWorthy(lead, s));
});

test('Foundation pitch: no website, high-ticket category, decent reviews', () => {
  const lead = {
    business_name: 'Smith Roofing',
    phone: '6095551234', normalized_phone: '6095551234',
    website_url: '', category: 'Roofing',
    county: 'Burlington', state: 'NJ', rating: 4.5, review_count: 60,
  };
  const s = scoreLead(lead);
  assert.equal(s.recommendedOffer, 'Website Foundation');
  assert.ok(s.score >= 40, `low-water mark: got ${s.score}`);
});

test('Disqualifier: permanently closed', () => {
  const lead = {
    business_name: 'Dead Co',
    phone: '6095551234', normalized_phone: '6095551234',
    business_status: 'CLOSED_PERMANENTLY',
    category: 'Roofing', county: 'Camden', state: 'NJ',
    rating: 4.5, review_count: 50,
  };
  const s = scoreLead(lead);
  assert.equal(s.grade, 'D');
  assert.ok(s.disqualifiers.includes('Permanently closed'));
  assert.equal(isCallTodayWorthy(lead, s), false);
});

test('Penalty: no phone number costs 20 points', () => {
  const a = { business_name: 'X', phone: '6095551234', normalized_phone: '6095551234',
              category: 'Roofing', county: 'Camden', state: 'NJ', rating: 4.5, review_count: 40 };
  const b = { ...a, phone: '', normalized_phone: '' };
  const sa = scoreLead(a);
  const sb = scoreLead(b);
  assert.ok(sa.score - sb.score >= 10, `expected ≥10pt drop, got ${sa.score - sb.score}`);
});

test('In-NJ but outside-SJ is NOT penalized (still sellable, just no Fit bonus)', () => {
  // Pre-Round-3 this was a -25 penalty that dragged Bergen/Essex/Middlesex
  // leads into D grade. Nate can sell to them — county only earns the Fit
  // bonus when it's in SJ, but it shouldn't punish otherwise.
  const lead = {
    business_name: 'Newark Tree', phone: '9735551234', normalized_phone: '9735551234',
    category: 'Tree Service', county: 'Essex', state: 'NJ',
    rating: 4.5, review_count: 50,
  };
  const s = scoreLead(lead);
  assert.ok(!s.penalties.some((p) => /South Jersey|Outside NJ/.test(p)),
    'no geographic penalty should fire for an in-NJ lead');
});

test('Outside-NJ IS still penalized (Nate does not sell outside NJ)', () => {
  const lead = {
    business_name: 'Philly Tree', phone: '2155551234', normalized_phone: '2155551234',
    category: 'Tree Service', county: 'Philadelphia', state: 'PA',
    rating: 4.5, review_count: 50,
  };
  const s = scoreLead(lead);
  assert.ok(s.penalties.some((p) => /Outside NJ/.test(p)));
});

test('Tracking pixels alone unlock Meta Ads recommendation', () => {
  // Round-3 change: if the auditor finds gtag / fbq / GTM / etc., that's
  // enough proof of advertising activity to recommend Meta Ads — without
  // requiring a manual ad_signal entry, which Nate said he'd never do.
  const lead = {
    business_name: 'Acme Roofing', phone: '6095551234', normalized_phone: '6095551234',
    website_url: 'https://acmeroofing.com',
    category: 'Roofing', county: 'Camden', state: 'NJ',
    rating: 4.6, review_count: 40,
    website_audit: {
      loads_successfully: true,
      has_tracking_pixels: true,
      has_click_to_call: false,
      has_quote_cta: false,
    },
    // NOTE: no ad_signal at all — proves the offer fires from pixels alone
  };
  const s = scoreLead(lead);
  assert.equal(s.recommendedOffer, 'Meta Ads Management');
});

test('Low-ticket category (restaurant) is penalized + offered Foundation', () => {
  const lead = {
    business_name: 'Mario\'s Pizza', phone: '6095551234', normalized_phone: '6095551234',
    category: 'Restaurant', county: 'Camden', state: 'NJ',
    rating: 4.6, review_count: 200,
  };
  const s = scoreLead(lead);
  assert.ok(s.penalties.some((p) => /Low-ticket/.test(p)));
});

// ── Constants helpers ────────────────────────────────────────────────────
test('guessCategory keyword matching', () => {
  assert.equal(guessCategory('Roofing contractor'),     'Roofing');
  assert.equal(guessCategory('Tree removal service'),    'Tree Service');
  assert.equal(guessCategory('Heating and Cooling'),     'HVAC');
  assert.equal(guessCategory('Plumber'),                 'Plumbing');
  assert.equal(guessCategory('Septic system service'),   'Septic Service');
  // Unknown stays unchanged so the user can re-map later
  assert.equal(guessCategory('Lemonade stand'),          'Lemonade stand');
});

test('gradeFor uses GPT-spec thresholds', () => {
  assert.equal(gradeFor(85), 'A+');
  assert.equal(gradeFor(82), 'A+');
  assert.equal(gradeFor(81), 'A');
  assert.equal(gradeFor(72), 'A');
  assert.equal(gradeFor(71), 'B');
  assert.equal(gradeFor(45), 'C');
  assert.equal(gradeFor(44), 'D');
});

test('categoryMeta returns tier for known categories', () => {
  assert.equal(categoryMeta('Roofing')?.tier,    'high');
  assert.equal(categoryMeta('Restaurant')?.tier, 'disqualify');
  assert.equal(categoryMeta('Landscaping')?.tier, 'mid');
  assert.equal(categoryMeta('Nonexistent'),       null);
});
