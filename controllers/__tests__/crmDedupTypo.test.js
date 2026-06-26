// controllers/__tests__/crmDedupTypo.test.js
//
// Typo-tolerant duplicate DETECTION (the /duplicates grouping core) — the fix for
// the owner still seeing two "Happy Leaf" cards: "Happy Leaf Dispensary" and
// "Happy Leaf Dispesary" (a missing 'n'). Their exact matchKeys differ by one
// char, so the old exact-only grouping missed them. groupDuplicateDocs now folds
// near-identical keys together CONSERVATIVELY — close typos merge, genuinely
// different companies never do.
//
//   node --test controllers/__tests__/crmDedupTypo.test.js
//
// Pure: groupDuplicateDocs (controllers/crm.js) takes plain Client POJOs (no DB)
// and matchKeysFuzzyEqual/matchKey/levenshtein (utils/fieldTrackerImport.js) are
// standalone — all testable directly.

const test = require('node:test');
const assert = require('node:assert/strict');

const { groupDuplicateDocs } = require('../crm');
const { matchKey, matchKeysFuzzyEqual, levenshtein } = require('../../utils/fieldTrackerImport');

// A minimal Client POJO (the shape /duplicates loads). companyKey is the strict
// identity (so two typo'd names are genuinely DISTINCT records); matchKey is the
// fuzzy grouping key the importer/derive stamps.
const doc = (name, over = {}) => ({
  companyKey: String(name).toLowerCase().replace(/[^a-z0-9]+/g, ''),
  companyName: name,
  clientName: '',
  matchKey: matchKey(name, ''),
  stage: 'lead',
  ...over,
});

const namesOf = (group) => group.map((d) => d.companyName).sort();

// ── levenshtein primitive ─────────────────────────────────────────────────────
test('levenshtein counts single-character edits', () => {
  assert.equal(levenshtein('dispensary', 'dispesary'), 1); // a dropped 'n'
  assert.equal(levenshtein('abc', 'abc'), 0);
  assert.equal(levenshtein('', 'abc'), 3);
  assert.equal(levenshtein('kitten', 'sitting'), 3);
});

// ── matchKeysFuzzyEqual: the conservative typo gate ───────────────────────────
test('THE Happy Leaf case: one dropped letter on a long name is a fuzzy match', () => {
  const a = matchKey('Happy Leaf Dispensary', '');
  const b = matchKey('Happy Leaf Dispesary', '');
  assert.notEqual(a, b, 'the exact keys genuinely differ (so old grouping missed it)');
  assert.ok(matchKeysFuzzyEqual(a, b), 'but they fuzzy-match as the same company');
});

test('matchKeysFuzzyEqual refuses short / generic stems', () => {
  assert.equal(matchKeysFuzzyEqual('acme', 'acne'), false);   // 4 chars — too short
  assert.equal(matchKeysFuzzyEqual('abc', 'abd'), false);
});

test('matchKeysFuzzyEqual refuses a DIFFERENT word even when edit-close', () => {
  // "acmeprint" vs "acmeprince": distance 2 on a 9-char key — over budget.
  assert.equal(matchKeysFuzzyEqual('acmeprint', 'acmeprince'), false);
  // Different lead token entirely.
  assert.equal(matchKeysFuzzyEqual('happyleafdispensary', 'bleuleafdispensary'), false);
  // Same shared suffix word, but the meaningful word differs (Dispensary vs
  // Industries) → far apart, never merged.
  assert.equal(matchKeysFuzzyEqual('greenthumbdispensary', 'greenthumbindustries'), false);
});

// The dangerous class: a SINGLE same-length substitution that flips the word's
// meaning while staying 1 edit away with a long shared prefix. These are DIFFERENT
// companies and must NEVER fuzzy-merge (a naïve "edit distance ≤ N" would fail).
test('matchKeysFuzzyEqual refuses a meaning-flipping single substitution', () => {
  assert.equal(matchKeysFuzzyEqual('riversideprinting', 'riversidepainting'), false); // printing↔painting
  assert.equal(matchKeysFuzzyEqual('mountainviewdental', 'mountainviewrental'), false); // dental↔rental
  assert.equal(matchKeysFuzzyEqual('cedarpointpark', 'cedarpointparc'), false);         // park↔parc
});

test('matchKeysFuzzyEqual still accepts genuine typos (insert/delete/transpose)', () => {
  assert.equal(matchKeysFuzzyEqual('northstarapparel', 'northstarapparrel'), true);  // doubled letter
  assert.equal(matchKeysFuzzyEqual('joespizza', 'joespizzas'), true);                 // trailing s
  assert.equal(matchKeysFuzzyEqual('greenfieldindusties', 'greenfieldindustries'), true); // dropped r
  assert.equal(matchKeysFuzzyEqual('recieving', 'receiving'), true);                  // ie/ei transposition
});

test('matchKeysFuzzyEqual requires a shared lead prefix (no tail-only similarity)', () => {
  // Same trailing word, totally different company name — must not merge.
  assert.equal(matchKeysFuzzyEqual('northgateprinting', 'southgateprinting'), false);
});

// ── groupDuplicateDocs: end-to-end grouping ───────────────────────────────────
test('groups the two typo Happy Leaf cards into ONE duplicate group', () => {
  const docs = [
    doc('Happy Leaf Dispensary'),
    doc('Happy Leaf Dispesary'),     // the typo card the owner still sees
    doc('Summit Signs'),             // unrelated, must stay out
  ];
  const groups = groupDuplicateDocs(docs);
  assert.equal(groups.length, 1, 'exactly one duplicate group');
  assert.deepEqual(namesOf(groups[0]), ['Happy Leaf Dispensary', 'Happy Leaf Dispesary']);
});

test('still groups EXACT matchKey duplicates (Acme vs Acme, Inc.)', () => {
  const docs = [
    doc('Acme'),
    doc('Acme, Inc.'),     // matchKey "acme" — same as "Acme"
  ];
  const groups = groupDuplicateDocs(docs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});

test('does NOT group two genuinely different companies that are merely similar', () => {
  const docs = [
    doc('Acme Print'),
    doc('Acme Prince'),    // different word — must remain two distinct records
  ];
  const groups = groupDuplicateDocs(docs);
  assert.equal(groups.length, 0, 'no false-merge group');
});

test('does NOT group a meaning-flipping 1-substitution pair (the near-miss guard)', () => {
  // "Riverside Printing" vs "Riverside Painting" are 1 edit apart with a long
  // shared prefix — but they're different businesses. Must stay two records.
  const docs = [doc('Riverside Printing'), doc('Riverside Painting')];
  assert.equal(groupDuplicateDocs(docs).length, 0, 'printing/painting must not merge');
  // And a dental office vs a rental company.
  assert.equal(groupDuplicateDocs([doc('Mountain View Dental'), doc('Mountain View Rental')]).length, 0);
});

test('a single record is never a duplicate group', () => {
  assert.deepEqual(groupDuplicateDocs([doc('Lonely Co')]), []);
  assert.deepEqual(groupDuplicateDocs([]), []);
  assert.deepEqual(groupDuplicateDocs(null), []);
});

test('records with no derivable matchKey are skipped (never grouped)', () => {
  // Symbol-only names reduce to an empty key.
  const docs = [doc('!!!'), doc('@@@')];
  assert.deepEqual(groupDuplicateDocs(docs), []);
});

test('a typo group also folds in an EXACT third member (transitively)', () => {
  // Two exact "Happy Leaf Dispensary" plus one typo'd "Dispesary": all three are
  // the same company and belong in one group.
  const docs = [
    { ...doc('Happy Leaf Dispensary'), companyKey: 'happyleafdispensary' },
    { ...doc('Happy Leaf Dispensary'), companyKey: 'happyleafdispensary-2' }, // distinct key, same name
    doc('Happy Leaf Dispesary'),
  ];
  const groups = groupDuplicateDocs(docs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 3, 'all three distinct keys in one group');
});
