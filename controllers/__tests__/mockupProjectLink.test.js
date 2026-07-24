// The project↔mockup link — the isolation boundary a client sees.
//
// Background: this link used to be decided four ways at once (an explicit list
// on the order, a string inside an untyped pageState blob, a fuzzy company-NAME
// match in the Studio, and an exclusion list to undo that match's mistakes). The
// fuzzy match quietly attached every one of a long-term client's mockups to
// every one of their projects, and that pile reached the client on any
// pre-confirmation approval link. These tests pin the replacement: a mockup
// number already names its project, so resolution is a lookup, never a guess.

const test = require('node:test');
const assert = require('node:assert');

const { resolveProjectFor } = require('../studioLibrary');
const { mockupScopeFor, projectScopeFor } = require('../../utils/mockupScope');
const { compareMockupNums, baseForProject, parseMockupNum } = require('../../utils/mockupNumbers');

const mk = (mockupNum) => ({ pageState: { mockupNum } });

test('resolveProjectFor: an explicit project number always wins', () => {
  // The editor knows exactly which order it is on — never second-guess it.
  const got = resolveProjectFor(mk('#000150A'), new Map(), new Set(['150']), '22-2');
  assert.strictEqual(got, '22-2');
});

test('resolveProjectFor: falls back to the order that references the number', () => {
  const orderMap = new Map([['150A', '150']]);
  assert.strictEqual(resolveProjectFor(mk('#000150A'), orderMap, new Set(['150'])), '150');
});

test('resolveProjectFor: the referencing order disambiguates sibling projects', () => {
  // '22-1' and '22-2' BOTH base to '#000022', so the number alone cannot tell
  // them apart. Whichever order actually lists the number owns it.
  assert.strictEqual(baseForProject('22-1'), baseForProject('22-2'));
  const orderMap = new Map([['22B', '22-2']]);
  const got = resolveProjectFor(mk('#000022B'), orderMap, new Set(['22-1', '22-2']));
  assert.strictEqual(got, '22-2');
});

test('resolveProjectFor: derives from the number when the project exists', () => {
  const got = resolveProjectFor(mk('#000150A'), new Map(), new Set(['150']));
  assert.strictEqual(got, '150', 'leading zeros are stripped to match Order.projectNumber');
});

test('resolveProjectFor: refuses to guess when the bare project does not exist', () => {
  // Only '22-1'/'22-2' exist — assigning '#000022B' to a bare '22' would invent
  // a project. Leaving it unlinked is the safe, visible state.
  const got = resolveProjectFor(mk('#000022B'), new Map(), new Set(['22-1', '22-2']));
  assert.strictEqual(got, '');
});

test('resolveProjectFor: unparseable and missing numbers stay unlinked', () => {
  assert.strictEqual(resolveProjectFor(mk('promo-shot'), new Map(), new Set(['150'])), '');
  assert.strictEqual(resolveProjectFor(mk(''), new Map(), new Set(['150'])), '');
  assert.strictEqual(resolveProjectFor({}, new Map(), new Set(['150'])), '');
  assert.strictEqual(resolveProjectFor(null, new Map(), new Set(['150'])), '');
});

test('resolveProjectFor: never matches on client name', () => {
  // The whole point. A mockup for a client with fifty projects resolves by its
  // number or not at all — the client's name is not evidence.
  const mockup = { client: 'Happy Leaf Dispensary', pageState: { mockupNum: '#000150A' } };
  const got = resolveProjectFor(mockup, new Map(), new Set(['999']));
  assert.strictEqual(got, '', 'no number match → unlinked, regardless of the client name');
});

test('mockupScopeFor: prefers the client, falls back to the project', () => {
  assert.deepStrictEqual(
    mockupScopeFor({ companyKey: 'happyleaf', projectNumber: '150' }),
    { store: 'mockups', companyKey: 'happyleaf' },
    'a confirmation may reference a design carried over from an earlier project of the same client',
  );
  assert.deepStrictEqual(
    mockupScopeFor({ projectNumber: '150' }),
    { store: 'mockups', projectNumber: '150' },
  );
});

test('mockupScopeFor: a keyless legacy order keeps the old unscoped behaviour', () => {
  assert.deepStrictEqual(mockupScopeFor({}), { store: 'mockups' });
  assert.deepStrictEqual(mockupScopeFor(null), { store: 'mockups' });
});

test('projectScopeFor: the strict per-project slice, or null', () => {
  assert.deepStrictEqual(
    projectScopeFor({ projectNumber: 150 }),
    { store: 'mockups', projectNumber: '150' },
    'numeric project numbers are stringified to match the stored field',
  );
  assert.strictEqual(projectScopeFor({ projectNumber: '' }), null);
  assert.strictEqual(projectScopeFor({}), null);
  assert.strictEqual(projectScopeFor(null), null);
});

test('compareMockupNums: colours and their edits sort adjacently, in sequence', () => {
  const shuffled = ['#000150B', '#000150A2', '#000150A', '#000150A10', '#000150C', '#000149Z'];
  const sorted = shuffled.slice().sort(compareMockupNums);
  assert.deepStrictEqual(sorted, [
    '#000149Z',
    '#000150A', '#000150A2', '#000150A10',
    '#000150B',
    '#000150C',
  ]);
});

test('compareMockupNums: edit versions order numerically, not lexically', () => {
  const sorted = ['#000150A10', '#000150A2'].sort(compareMockupNums);
  assert.deepStrictEqual(sorted, ['#000150A2', '#000150A10']);
});

test('compareMockupNums: external promo shots sort last, stably', () => {
  const sorted = ['Plastic Grinder', '#000150A', 'Lighter'].sort(compareMockupNums);
  assert.deepStrictEqual(sorted, ['#000150A', 'Lighter', 'Plastic Grinder']);
});

test('a mockup number names exactly one project base', () => {
  // The invariant the whole design rests on.
  assert.strictEqual(parseMockupNum('#000150A2').digits, '000150');
  assert.strictEqual(baseForProject('150'), '#000150');
  assert.strictEqual(parseMockupNum('#000150A2').base, baseForProject('150'));
});
