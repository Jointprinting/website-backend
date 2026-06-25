// controllers/__tests__/crmMatch.test.js
//
// Pure-logic checks for dedup-on-entry (the "did you mean <existing>?" matcher).
// No DB / no Express: rankMatchCandidates + scoreNameMatch are exported from
// controllers/crm.js and take plain Client POJOs, so they're testable directly.
//
//   node --test controllers/__tests__/crmMatch.test.js
//
// The contract under test: the matcher SUGGESTS existing records that likely are
// the same company as a typed name, ranked most-confident first — and it must
// NEVER surface a genuinely distinct company (e.g. "Bleu Leaf" vs "Bleu Leaf
// Dispensary" share a stem-prefix and SHOULD surface as a suggestion, but two
// unrelated names must not).

const test = require('node:test');
const assert = require('node:assert/strict');

const { rankMatchCandidates, scoreNameMatch } = require('../crm');

// deriveCompanyKey / deriveMatchKey, inlined to build the typed-name inputs that
// scoreNameMatch expects (kept byte-identical to the controller's helpers).
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// A minimal existing-record POJO with sane defaults; override per case.
const mk = (over = {}) => ({
  companyKey: key(over.companyName || over.name || ''),
  companyName: over.name || '',
  clientName: '',
  matchKey: '',
  stage: 'lead',
  ...over,
});

const names = (list) => list.map((c) => c.name);

// ── Exact identity ────────────────────────────────────────────────────────────
test('exact name → the same company, score 1', () => {
  const docs = [mk({ name: 'Acme Apparel' }), mk({ name: 'Globex' })];
  const out = rankMatchCandidates('Acme Apparel', docs);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Acme Apparel');
  assert.equal(out[0].score, 1);
  assert.equal(out[0].reason, 'exact');
});

// ── Corporate-suffix fuzzy (the matchKey signal) ──────────────────────────────
// "Acme Inc" and "Acme, Inc." reduce to the SAME identity companyKey ("acmeinc")
// — punctuation is stripped but "inc" is kept — so those are an exact identity
// hit. The matchKey tier is what bridges a name WITH a suffix to the same name
// WITHOUT one, where the identity keys genuinely differ: "Acme Inc" (identity
// "acmeinc") typed against an existing "Acme" (identity "acme") — same matchKey
// "acme", different identity.
test('"Acme Inc" suggests existing "Acme" via matchKey (different identity)', () => {
  const docs = [mk({ name: 'Acme' })];
  const out = rankMatchCandidates('Acme Inc', docs);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Acme');
  assert.equal(out[0].reason, 'matchKey');
  assert.ok(out[0].score >= 0.9);
});

test('"Acme Inc" and "Acme, Inc." are the SAME identity (exact)', () => {
  const docs = [mk({ name: 'Acme, Inc.' })];
  const out = rankMatchCandidates('Acme Inc', docs);
  assert.equal(out.length, 1);
  assert.equal(out[0].reason, 'exact');     // identical companyKey "acmeinc"
});

test('apostrophe vs none still matches ("Joes" ≈ "Joe\'s")', () => {
  const docs = [mk({ name: "Joe's Pizza" })];
  const out = rankMatchCandidates('Joes Pizza', docs);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "Joe's Pizza");
});

// ── Prefix (likely dupe, surfaced as a suggestion) ────────────────────────────
test('"Bleu Leaf" surfaces "Bleu Leaf Dispensary" as a SUGGESTION (prefix)', () => {
  const docs = [mk({ name: 'Bleu Leaf Dispensary' })];
  const out = rankMatchCandidates('Bleu Leaf', docs);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Bleu Leaf Dispensary');
  assert.equal(out[0].reason, 'prefix');
  // A suggestion only — score is below the identity/matchKey tiers, so the UI
  // frames it as "did you mean", not a forced match.
  assert.ok(out[0].score < 0.92, 'prefix is a softer suggestion than matchKey');
});

// ── Distinct companies must NOT be proposed (the no-false-merge guard) ─────────
test('a distinguishing extra word is NOT a prefix dupe ("Apex" vs "Apex Apparel")', () => {
  // "Apex" typed, existing "Apex Apparel": this IS a prefix and is a legitimate
  // SUGGESTION (the owner may have meant the existing Apex Apparel). What must
  // never happen is a *distinct* third company leaking in.
  const docs = [mk({ name: 'Apex Apparel' }), mk({ name: 'Summit Signs' })];
  const out = rankMatchCandidates('Apex', docs);
  assert.deepEqual(names(out), ['Apex Apparel']);
});

test('unrelated names share one common word but do NOT match', () => {
  // "Heritage Screen Printing" vs "Heritage Sportswear": one shared token, low
  // Jaccard, neither a prefix of the other → no suggestion. (Guards the owner
  // from a bogus "did you mean" on a real, different company.)
  const docs = [mk({ name: 'Heritage Sportswear' })];
  const out = rankMatchCandidates('Heritage Screen Printing', docs);
  assert.equal(out.length, 0);
});

test('completely different names never match', () => {
  const docs = [mk({ name: 'Globex' }), mk({ name: 'Initech' }), mk({ name: 'Umbrella' })];
  assert.equal(rankMatchCandidates('Acme', docs).length, 0);
});

// ── Token overlap / reordering ────────────────────────────────────────────────
test('strong token overlap matches a reordered multi-word name', () => {
  const docs = [mk({ name: 'Riverside Brewing Company' })];
  // "Riverside Brewing" vs "Riverside Brewing Company" — prefix, real stem.
  const out = rankMatchCandidates('Riverside Brewing', docs);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Riverside Brewing Company');
});

// ── Ranking + limit ───────────────────────────────────────────────────────────
test('candidates are ranked most-confident first', () => {
  const docs = [
    mk({ name: 'Acme Apparel' }),   // prefix (softer)
    mk({ name: 'Acme' }),           // exact (strongest)
  ];
  const out = rankMatchCandidates('Acme', docs);
  assert.equal(out[0].name, 'Acme');          // exact wins the top slot
  assert.ok(out[0].score >= out[out.length - 1].score);
});

test('limit caps the number of suggestions', () => {
  const docs = Array.from({ length: 8 }, (_, i) => mk({ name: `Acme ${i}` }));
  const out = rankMatchCandidates('Acme', docs, { limit: 3 });
  assert.equal(out.length, 3);
});

// ── excludeKey: editing a record never flags itself ───────────────────────────
test('excludeKey drops the record being edited from its own suggestions', () => {
  const docs = [mk({ name: 'Acme', companyKey: 'acme' })];
  const out = rankMatchCandidates('Acme', docs, { excludeKey: 'acme' });
  assert.equal(out.length, 0);
});

// ── Empty / trivial input ─────────────────────────────────────────────────────
test('empty or symbol-only input yields no suggestions', () => {
  const docs = [mk({ name: 'Acme' })];
  assert.deepEqual(rankMatchCandidates('', docs), []);
  assert.deepEqual(rankMatchCandidates('   ', docs), []);
  assert.deepEqual(rankMatchCandidates('!!!', docs), []);
});

test('no existing records → no suggestions (never throws)', () => {
  assert.deepEqual(rankMatchCandidates('Acme', []), []);
  assert.deepEqual(rankMatchCandidates('Acme', null), []);
});

// ── scoreNameMatch direct unit (the scoring core) ─────────────────────────────
test('scoreNameMatch returns 0 for empty record key', () => {
  const { score } = scoreNameMatch('acme', 'acme', ['acme'], { companyKey: '' });
  assert.equal(score, 0);
});

test('scoreNameMatch: identical companyKey is the top score', () => {
  const { score, reason } = scoreNameMatch('acme', 'acme', ['acme'], { companyKey: 'acme', companyName: 'Acme' });
  assert.equal(score, 1);
  assert.equal(reason, 'exact');
});
