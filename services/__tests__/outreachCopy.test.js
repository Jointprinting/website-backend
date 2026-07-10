// services/__tests__/outreachCopy.test.js
//
// Pure-logic checks for the outreach AI-drafting service (no DB, no network,
// no model call):
//
//   node --test services/__tests__/outreachCopy.test.js
//
// The parts worth pinning are the ones that guard real sends: the merge-token
// vocabulary staying in lockstep with the engine's buildMergeContext (a drifted
// token renders blank in a real cold email), the defensive coercion of the
// model's JSON into the campaign-step contract, and the reply-body scrubbing
// (a reply goes to a real person — no braces, no stray subject line).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KNOWN_MERGE_FIELDS,
  MERGE_ALIASES,
  DEFAULT_OFFSETS,
  sanitizeMergeTokens,
  sanitizeReplyBody,
  sanitizeSequenceSteps,
  buildReplyPrompt,
  buildSequencePrompt,
} = require('../outreachCopy');
const { buildMergeContext } = require('../outreachEngine');

// ── Merge vocabulary sync ─────────────────────────────────────────────────────
test('KNOWN_MERGE_FIELDS matches buildMergeContext exactly (the real sender vocabulary)', () => {
  // The engine is the source of truth: a token outside its context renders as
  // the fallback (or '') on every send. If this fails, a field was added or
  // removed in services/outreachEngine.js buildMergeContext — update
  // KNOWN_MERGE_FIELDS in services/outreachCopy.js (and the frontend
  // MERGE_FIELDS mirror in src/screens/studio/outreach/_outreach.js).
  const engineFields = Object.keys(buildMergeContext({}));
  assert.deepEqual([...KNOWN_MERGE_FIELDS].sort(), [...engineFields].sort());
});

test('every merge alias points at a real field', () => {
  for (const target of Object.values(MERGE_ALIASES)) {
    assert.ok(KNOWN_MERGE_FIELDS.includes(target), `alias target "${target}" is not a known field`);
  }
});

// ── sanitizeMergeTokens ───────────────────────────────────────────────────────
test('sanitizeMergeTokens keeps known tokens verbatim, fallbacks included', () => {
  const s = 'Hi {{greeting}} from {{city|your area}} at {{companyName}}';
  assert.equal(sanitizeMergeTokens(s), s);
});

test('sanitizeMergeTokens rewrites aliased near-misses onto the real token', () => {
  assert.equal(sanitizeMergeTokens('merch for {{company}}'), 'merch for {{companyName}}');
  assert.equal(sanitizeMergeTokens('hey {{firstname|there}}'), 'hey {{firstName|there}}');
  assert.equal(sanitizeMergeTokens('hey {{first_name}}'), 'hey {{firstName}}');
});

test('sanitizeMergeTokens resolves unknown tokens to their fallback (or drops them)', () => {
  // Same behavior renderTemplate applies at send time — never leak braces.
  assert.equal(sanitizeMergeTokens('for {{shopType|your shop}} owners'), 'for your shop owners');
  assert.equal(sanitizeMergeTokens('hello {{madeUpField}}!'), 'hello !');
});

test('sanitizeMergeTokens stripAll resolves EVERY token, known ones included', () => {
  assert.equal(
    sanitizeMergeTokens('{{greeting}} thanks for {{companyName|the shop}}', { stripAll: true }),
    ' thanks for the shop',
  );
});

// ── sanitizeReplyBody ─────────────────────────────────────────────────────────
test('sanitizeReplyBody accepts { body } or a bare string, trimmed', () => {
  assert.equal(sanitizeReplyBody({ body: '  Thanks for reaching out.\n\nNate  ' }), 'Thanks for reaching out.\n\nNate');
  assert.equal(sanitizeReplyBody('  plain string  '), 'plain string');
});

test('sanitizeReplyBody drops a stray leading Subject: line (replies have no subject)', () => {
  assert.equal(sanitizeReplyBody({ body: 'Subject: Re: merch\n\nHey Sam, thanks.' }), 'Hey Sam, thanks.');
});

test('sanitizeReplyBody strips ALL merge tokens — a reply goes to a real person', () => {
  assert.equal(sanitizeReplyBody({ body: '{{greeting}} thanks {{firstName|friend}}!' }), 'thanks friend!');
});

test('sanitizeReplyBody handles junk input and caps runaway length', () => {
  assert.equal(sanitizeReplyBody(null), '');
  assert.equal(sanitizeReplyBody({ body: 42 }), '');
  assert.equal(sanitizeReplyBody({ body: 'x'.repeat(5000) }).length, 2000);
});

// ── sanitizeSequenceSteps ─────────────────────────────────────────────────────
const step = (subject, body, offsetDays) => ({ subject, body, offsetDays });

test('sanitizeSequenceSteps coerces a clean 4-touch onto the step contract', () => {
  const out = sanitizeSequenceSteps({
    steps: [
      step(' intro ', ' {{greeting}}\n\nbody one\n\nNate ', 0),
      step('bump', 'body two', 3),
      step('nudge', 'body three', 7),
      step('breakup', 'body four', 14),
    ],
  }, 4);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((s) => s.offsetDays), [0, 3, 7, 14]);
  assert.equal(out[0].subject, 'intro');                       // trimmed
  assert.equal(out[0].body, '{{greeting}}\n\nbody one\n\nNate'); // known token kept
});

test('sanitizeSequenceSteps accepts a bare array and drops body-less steps', () => {
  const out = sanitizeSequenceSteps([
    step('has body', 'real body', 0),
    step('no body', '   ', 3),
    step('also real', 'another body', 5),
  ], 4);
  assert.deepEqual(out.map((s) => s.subject), ['has body', 'also real']);
});

test('sanitizeSequenceSteps forces the first offset to 0 and later ones ≥ 1', () => {
  const out = sanitizeSequenceSteps([
    step('a', 'one', 5),      // model got touch 1 wrong → 0
    step('b', 'two', 0),      // follow-up can't be same-day → default ladder
    step('c', 'three', 2.6),  // rounded
  ], 4);
  assert.deepEqual(out.map((s) => s.offsetDays), [0, 3, 3]);
});

test('sanitizeSequenceSteps defaults junk offsets to the 0/3/7/14 ladder', () => {
  const out = sanitizeSequenceSteps([
    step('a', 'one', 'now'),
    step('b', 'two', null),
    step('c', 'three', -4),
    step('d', 'four', undefined),
  ], 4);
  assert.deepEqual(out.map((s) => s.offsetDays), DEFAULT_OFFSETS);
});

test('sanitizeSequenceSteps caps at the requested touches and clamps to sane bounds', () => {
  const many = Array.from({ length: 9 }, (_, i) => step(`s${i}`, `b${i}`, i));
  assert.equal(sanitizeSequenceSteps(many, 4).length, 4);
  assert.equal(sanitizeSequenceSteps(many, 99).length, 6);   // MAX_TOUCHES
  assert.equal(sanitizeSequenceSteps(many, 0).length, 4);    // junk → default 4
});

test('sanitizeSequenceSteps resolves unknown merge tokens in subjects/bodies', () => {
  const out = sanitizeSequenceSteps([
    step('merch for {{company}}', 'hi {{shopKind|there}}, from {{city|your area}}', 0),
  ], 4);
  assert.equal(out[0].subject, 'merch for {{companyName}}');       // alias fixed
  assert.equal(out[0].body, 'hi there, from {{city|your area}}');  // unknown → fallback, known kept
});

test('sanitizeSequenceSteps returns [] for junk payloads', () => {
  assert.deepEqual(sanitizeSequenceSteps(null), []);
  assert.deepEqual(sanitizeSequenceSteps('nope'), []);
  assert.deepEqual(sanitizeSequenceSteps({ steps: 'nope' }), []);
});

// ── Prompt builders ───────────────────────────────────────────────────────────
test('buildReplyPrompt grounds the model in the reply + CRM context', () => {
  const p = buildReplyPrompt({
    reply: { fromName: 'Sam Rivera', fromEmail: 'sam@greenleaf.com', subject: 'Re: merch', snippet: 'how much for 50 hoodies?', category: 'asked_pricing', suggestedAction: 'Send a quote' },
    client: { companyName: 'Green Leaf Dispensary', clientName: 'Sam Rivera', stage: 'contacted', lastContact: new Date('2026-07-01T12:00:00Z') },
    orders: [],
  });
  assert.match(p, /how much for 50 hoodies\?/);
  assert.match(p, /Green Leaf Dispensary/);
  assert.match(p, /asked_pricing/);
  assert.match(p, /contacted/);
  assert.match(p, /2026-07-01/);
  assert.match(p, /no orders yet/);
});

test('buildReplyPrompt survives an unmatched reply (no client, no orders)', () => {
  const p = buildReplyPrompt({ reply: { fromEmail: 'x@y.com', snippet: 'interested' } });
  assert.match(p, /Company: unknown/);
  assert.match(p, /never \(cold\)/);
});

test('buildReplyPrompt flags an existing customer from placed orders', () => {
  const p = buildReplyPrompt({ reply: {}, client: {}, orders: [{}, {}] });
  assert.match(p, /existing customer — 2 placed orders/);
});

test('buildSequencePrompt defaults to cannabis dispensaries and folds in notes', () => {
  assert.match(buildSequencePrompt({}), /4-touch cold-email sequence targeting cannabis dispensaries/);
  const p = buildSequencePrompt({ vertical: 'breweries', touches: 4, notes: 'push staff tees' });
  assert.match(p, /targeting breweries/);
  assert.match(p, /push staff tees/);
});
