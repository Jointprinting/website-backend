// Is this company a cold-outreach target at all? The regression that made this
// file necessary: the owner's send queue held "Harmony Hemp Farmacy",
// "Tennessee Hemp Care", "Mary Jane's CBD Dispensary - Smoke & Vape Shop" and
// "Your CBD Haven" while the bounce rate climbed to 18.9%.

const test = require('node:test');
const assert = require('node:assert');

const {
  nonRetailNameReason, nonRetailNameFilter, fieldMapExclusions, sendFitReason,
} = require('../leadFit');

// The exact names off the owner's queue screenshot. Every one of these must die.
const FROM_THE_QUEUE = [
  'Harmony Hemp Farmacy',
  'Tennessee Hemp Care',
  "Mary Jane's CBD Dispensary - Smoke & Vape Shop",
  'Your CBD Haven',
  'Kiss Glass',
  'Your CBD Store',
];

test('the shops that were actually in the send queue are named as non-targets', () => {
  for (const name of FROM_THE_QUEUE) {
    assert.notStrictEqual(nonRetailNameReason(name), '', `${name} should be excluded`);
  }
});

test('"dispensary" in the name does not rescue a CBD shop', () => {
  // A CBD store calling itself a dispensary is still not a licensed dispensary.
  assert.strictEqual(nonRetailNameReason("Mary Jane's CBD Dispensary - Smoke & Vape Shop"), 'hemp-cbd');
});

test('smoke / vape / head shops are named too', () => {
  for (const name of ['Cloud 9 Smoke Shop', 'Puff Vape & Glass', 'The Head Shop', 'Hookah Palace', 'Ace Tobacco & Cigars', 'Smoke and Vape City']) {
    assert.strictEqual(nonRetailNameReason(name), 'smoke-shop', name);
  }
});

test('licensed dispensaries are NOT swept up', () => {
  // A false positive here costs a real buyer, so the rules are word-boundary
  // matched and this list is the guard on that.
  for (const name of [
    'Green Thumb Dispensary', 'Rise Cannabis', 'Curaleaf', 'Sunnyside',
    'The Apothecarium', 'Lucky Strains', 'Missouri Wild', 'Herbal Wellness Center',
    'Chempion Cannabis Co',       // 'hemp' is a substring here, not a word
    'Glasgow Cannabis Company',   // 'glas' is a substring here, not a word
    'Cascade Provisions', 'Terrapin Care Station', 'House of Dank',
  ]) {
    assert.strictEqual(nonRetailNameReason(name), '', `${name} should pass`);
  }
});

test('blank and junk names say nothing', () => {
  for (const name of ['', null, undefined, '   ']) {
    assert.strictEqual(nonRetailNameReason(name), '');
  }
});

test('the Mongo filter carries the same rules', () => {
  const f = nonRetailNameFilter('name');
  assert.ok(Array.isArray(f.$nor) && f.$nor.length >= 2);
  // Each clause must be { name: <RegExp> } — a string would silently match
  // nothing and the sourcing query would keep returning hemp shops.
  for (const clause of f.$nor) {
    assert.ok(clause.name instanceof RegExp, 'clause must hold a RegExp');
  }
  // And they must actually match the queue names, since this is what runs in Mongo.
  assert.ok(f.$nor.some((c) => c.name.test('Harmony Hemp Farmacy')));
  assert.ok(f.$nor.some((c) => c.name.test('Cloud 9 Smoke Shop')));
});

test('a rec-state segment does not rescue a CBD shop (the actual leak)', () => {
  // deriveSegment() reads the STATE, so every Google pin in Michigan is stamped
  // 'rec' whatever business it is. The name has to outrank that.
  const rows = [{ companyKey: 'yourcbdhaven', name: 'Your CBD Haven', state: 'MI', segment: 'rec', isChain: false }];
  const { excluded, notRetailBusiness } = fieldMapExclusions(rows);
  assert.strictEqual(excluded.get('yourcbdhaven'), 'hemp-cbd');
  assert.strictEqual(notRetailBusiness, 1);
});

test('a real dispensary row in a legal state still passes', () => {
  const rows = [{ companyKey: 'greenthumb', name: 'Green Thumb Dispensary', state: 'MI', segment: 'rec', isChain: false }];
  const { excluded } = fieldMapExclusions(rows);
  assert.strictEqual(excluded.has('greenthumb'), false);
});

test('chain still outranks the name check', () => {
  const rows = [{ companyKey: 'x', name: 'Big CBD Chain', state: 'MI', segment: 'rec', isChain: true }];
  const { excluded, chains, notRetailBusiness } = fieldMapExclusions(rows);
  assert.strictEqual(excluded.get('x'), 'chain');
  assert.strictEqual(chains, 1);
  assert.strictEqual(notRetailBusiness, 0, 'one company is counted once, in one bucket');
});

test('includeNonRetail turns the name screen off', () => {
  const rows = [{ companyKey: 'yourcbdhaven', name: 'Your CBD Haven', state: 'MI', segment: 'rec' }];
  const { excluded } = fieldMapExclusions(rows, { includeNonRetail: true });
  assert.strictEqual(excluded.has('yourcbdhaven'), false);
});

// ── The send gate ────────────────────────────────────────────────────────────

test('sendFitReason fires on the name with ZERO map rows', () => {
  // This is the whole point. OSM-sourced leads never get a Dispensary row, and
  // the row-joined gate is deliberately silent without rows — which is exactly
  // how a Tennessee hemp shop kept getting mail.
  assert.strictEqual(sendFitReason([], { name: 'Tennessee Hemp Care' }), 'hemp-cbd');
  assert.strictEqual(sendFitReason([], { name: 'Cloud 9 Smoke Shop' }), 'smoke-shop');
});

test('sendFitReason stays silent for an unmapped lead with an ordinary name', () => {
  // A referral or hand-added prospect must not be blocked by a map that never
  // saw it — the original contract, still intact.
  assert.strictEqual(sendFitReason([], { name: 'Lucky Strains' }), '');
  assert.strictEqual(sendFitReason([]), '');
});

test('sendFitReason honours includeNonRetail on the name path', () => {
  assert.strictEqual(sendFitReason([], { name: 'Your CBD Haven', includeNonRetail: true }), '');
});

test('sendFitReason still reads the rows when the name is clean', () => {
  const rows = [{ companyKey: 'shop', name: 'Some Shop', state: 'TN', segment: 'hemp' }];
  assert.strictEqual(sendFitReason(rows, { name: 'Some Shop' }), 'non-retail');
});

// ── The escape hatch has to actually be reachable ────────────────────────────
// includeChains / includeNonRetail live under campaign.enrollFilters — that is
// where the model declares them and what sanitizeEnrollFilters reads. Both the
// send gate and the fit sweep were reading them off the campaign's top level,
// where they have never existed, so `!!undefined` made the opt-in inoperative:
// a campaign that opted these shops back IN would enroll them and then stop them
// one at a time at the send, which reads as the engine refusing its own queue.

test('the send gate and the fit sweep read the opt-in where it lives', () => {
  const src = require('fs').readFileSync(require.resolve('../outreachEngine'), 'utf8');
  // CODE only — the comments explaining this bug quote the broken form.
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /campaign\.includeNonRetail\b/,
    'includeNonRetail is under campaign.enrollFilters, never on the campaign itself');
  assert.doesNotMatch(code, /campaign\.includeChains\b/,
    'includeChains is under campaign.enrollFilters, never on the campaign itself');
  assert.match(code, /campaign\.enrollFilters && campaign\.enrollFilters\.includeNonRetail/);
});
