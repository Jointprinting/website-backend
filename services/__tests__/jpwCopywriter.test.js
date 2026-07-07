// services/__tests__/jpwCopywriter.test.js
//
// JP Webworks AI copywriter — pure-logic checks (no network):
//
//   node --test services/__tests__/jpwCopywriter.test.js
//
// The risky part isn't the API call (that's exercised live) — it's turning the
// model's free-form JSON into the exact site `data` contract WITHOUT ever
// letting a fabricated fact through. sanitizeGeneratedData() is where that
// honesty guarantee lives, so it gets the bulk of the coverage.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isConfigured,
  generateSiteCopy,
  buildCopyPrompt,
  sanitizeGeneratedData,
  computeNeeds,
  SITE_COPY_TOOL,
  MODEL,
} = require('../jpwCopywriter');

// ── Tool / model wiring ───────────────────────────────────────────────────────
test('the forced tool is shaped for structured output', () => {
  assert.equal(SITE_COPY_TOOL.name, 'write_site_copy');
  assert.equal(SITE_COPY_TOOL.input_schema.type, 'object');
  // The copy fields the site contract expects are all declared.
  const props = SITE_COPY_TOOL.input_schema.properties;
  for (const k of ['tagline', 'heroHeadline', 'ctaLabel', 'about', 'services', 'hours', 'testimonials', 'phone', 'email', 'address', 'established', 'license', 'serviceArea']) {
    assert.ok(props[k], `tool schema is missing ${k}`);
  }
});

test('default model is Sonnet 5, env-overridable', () => {
  assert.equal(MODEL, process.env.JPW_COPY_MODEL || 'claude-sonnet-5');
});

// ── Prompt builder ────────────────────────────────────────────────────────────
test('buildCopyPrompt grounds the model in the business, brief, template vibe, and tone', () => {
  const p = buildCopyPrompt({
    businessName: 'Ironside Plumbing',
    businessType: 'Plumber',
    templateId: 'trades',
    brief: 'Family plumber serving Mount Holly since 2012.',
    tone: 'Bold',
  });
  assert.match(p, /Ironside Plumbing/);
  assert.match(p, /Plumber/);
  assert.match(p, /Family plumber serving Mount Holly/);
  assert.match(p, /no-nonsense/);          // the trades vibe
  assert.match(p, /bold tone/);            // the owner's chosen tone
  assert.match(p, /write_site_copy/);      // instructed to call the tool
});

test('buildCopyPrompt ignores an unknown tone and falls back on an unknown template vibe', () => {
  const p = buildCopyPrompt({ businessName: 'X', templateId: 'nope', brief: 'b', tone: 'Sassy' });
  assert.doesNotMatch(p, /sassy tone/i);   // bogus tone dropped
  assert.match(p, /trustworthy/);          // default vibe
});

// ── sanitizeGeneratedData: garbage in → safe contract out ─────────────────────
test('non-object input yields the empty safe contract', () => {
  for (const junk of [null, undefined, 'nope', 42, []]) {
    const out = sanitizeGeneratedData(junk, '');
    assert.deepEqual(out.hours, []);
    assert.deepEqual(out.services, []);
    assert.deepEqual(out.testimonials, []);
    assert.equal(out.tagline, '');
    assert.equal(out.about, '');
    // No fabricated contact/factual keys when there's nothing to gate on.
    for (const k of ['phone', 'email', 'address', 'established', 'license']) {
      assert.equal(k in out, false, `${k} should be absent`);
    }
  }
});

test('unknown keys are dropped and non-array fields are coerced to arrays', () => {
  const out = sanitizeGeneratedData({
    tagline: '  Honest work  ',
    evil: 'DROP ME',
    services: 'not an array',
    hours: { days: 'Mon' },   // object, not array
    testimonials: 'nope',
  }, 'some brief');
  assert.equal(out.tagline, 'Honest work');   // trimmed
  assert.equal('evil' in out, false);          // unknown key gone
  assert.deepEqual(out.services, []);          // coerced
  assert.deepEqual(out.hours, []);
  assert.deepEqual(out.testimonials, []);
});

// ── Contact / factual gating: kept ONLY when the brief supplies them ──────────
test('contact + factual details survive only when the brief contains that kind of fact', () => {
  const raw = {
    phone: '(609) 555-0143',
    email: 'office@ironside.com',
    address: '12 Main St, Mount Holly, NJ 08060',
    established: '2012',
    license: 'NJ Lic. #12345',
  };
  const briefWith = 'Call us at (609) 555-0143 or office@ironside.com. We are at 12 Main St, Mount Holly, NJ 08060. In business since 2012, NJ Lic. #12345.';
  const kept = sanitizeGeneratedData(raw, briefWith);
  assert.equal(kept.phone, '(609) 555-0143');
  assert.equal(kept.email, 'office@ironside.com');
  assert.equal(kept.address, '12 Main St, Mount Holly, NJ 08060');
  assert.equal(kept.established, '2012');
  assert.equal(kept.license, 'NJ Lic. #12345');
});

test('fabricated contact + factual details are stripped when the brief lacks them', () => {
  const raw = {
    phone: '(609) 555-0143',        // model invented all of these
    email: 'office@ironside.com',
    address: '12 Main St, Mount Holly, NJ',
    established: '2012',
    license: 'NJ Lic. #12345',
    tagline: 'Honest plumbing',
  };
  const briefWithout = 'A friendly family plumber that does drains and water heaters and always cleans up.';
  const out = sanitizeGeneratedData(raw, briefWithout);
  assert.equal(out.tagline, 'Honest plumbing');   // copy still comes through
  for (const k of ['phone', 'email', 'address', 'established', 'license']) {
    assert.equal(k in out, false, `${k} should have been stripped`);
  }
});

// ── Testimonials: never fabricated — need a real name ─────────────────────────
test('testimonials without a real name are dropped', () => {
  const out = sanitizeGeneratedData({
    testimonials: [
      { quote: 'They were great!' },                 // no name
      { quote: 'Fast and fair', name: '' },          // empty name
      { name: 'Maria G.' },                          // no quote
    ],
  }, 'brief with no reviews');
  assert.deepEqual(out.testimonials, []);
});

test('a real quote with a real name is kept', () => {
  const out = sanitizeGeneratedData({
    testimonials: [{ quote: 'Fixed my heater same day.', name: 'Maria G.' }],
  }, 'Maria G. said: "Fixed my heater same day."');
  assert.equal(out.testimonials.length, 1);
  assert.deepEqual(out.testimonials[0], { quote: 'Fixed my heater same day.', name: 'Maria G.' });
});

// ── Services + prices ─────────────────────────────────────────────────────────
test('services are trimmed, name-required, and capped at 6', () => {
  const raw = {
    services: [
      { name: '  Drain cleaning ', desc: ' Clears clogs ' },
      { name: '', desc: 'nameless — dropped' },
      { name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }, { name: 'F' }, { name: 'G' },
    ],
  };
  const out = sanitizeGeneratedData(raw, 'no money mentioned');
  assert.equal(out.services.length, 6);                 // capped
  assert.deepEqual(out.services[0], { name: 'Drain cleaning', desc: 'Clears clogs' }); // trimmed, no price
});

test('service prices are stripped unless the brief implies money', () => {
  const raw = { services: [{ name: 'Tune-up', desc: 'x', price: 'from $95' }] };
  const noMoney = sanitizeGeneratedData(raw, 'we do tune-ups and repairs');
  assert.equal('price' in noMoney.services[0], false);

  const withMoney = sanitizeGeneratedData(raw, 'Tune-ups start at $95.');
  assert.equal(withMoney.services[0].price, 'from $95');
});

// ── Hours ─────────────────────────────────────────────────────────────────────
test('hours keep only rows with content', () => {
  const out = sanitizeGeneratedData({
    hours: [
      { days: 'Mon – Fri', hours: '9–5' },
      { days: '', hours: '' },       // blank row dropped
      { days: 'Sat' },               // partial row kept
    ],
  }, '');
  assert.deepEqual(out.hours, [
    { days: 'Mon – Fri', hours: '9–5' },
    { days: 'Sat', hours: '' },
  ]);
});

// ── needs meta (what the owner must still supply) ─────────────────────────────
test('computeNeeds always flags photos, and testimonials/contact when missing', () => {
  const empty = computeNeeds({ testimonials: [], phone: '', email: '' });
  assert.deepEqual(empty, ['testimonials', 'contact info', 'photos']);

  const full = computeNeeds({
    testimonials: [{ quote: 'x', name: 'y' }], phone: '(609) 555-0143', email: '',
  });
  assert.deepEqual(full, ['photos']);   // has a review + a phone → only photos left
});

// ── generateSiteCopy never throws on a model/SDK failure ──────────────────────
// (Skipped when a real key is present so the suite never touches the network.)
test('generateSiteCopy returns a clean { error } rather than throwing when unconfigured',
  { skip: isConfigured() ? 'ANTHROPIC_API_KEY is set — would hit the network' : false },
  async () => {
    const res = await generateSiteCopy({
      businessName: 'X', businessType: 'Plumber', templateId: 'trades', brief: 'b',
    });
    assert.equal(typeof res.error, 'string');
    assert.ok(res.error.length > 0);
    assert.equal(res.data, undefined);
  });
