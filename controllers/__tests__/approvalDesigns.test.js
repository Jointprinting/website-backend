// What a client sees on a pre-confirmation approval link.
//
// A mockup number carries design → colour → edit version, so #000150A and
// #000150B are two colourways of one design while #000150A2 is the second EDIT
// of colour A. Shown flat, four colourways after a couple of revision rounds
// become ten tiles — several of them proofs the client has already been talked
// out of. Collapsing each colour to its latest edit is what the numbering was
// designed to make possible.

const test = require('node:test');
const assert = require('node:assert');

const { _latestPerColour, _clientDesigns } = require('../approval');

test('collapses a colour lane to its latest edit', () => {
  assert.deepStrictEqual(
    _latestPerColour(['#000150A', '#000150A2', '#000150A3']),
    ['#000150A3'],
  );
});

test('keeps every colour — colours are different designs, not revisions', () => {
  assert.deepStrictEqual(
    _latestPerColour(['#000150A', '#000150B', '#000150C']),
    ['#000150A', '#000150B', '#000150C'],
  );
});

test('the real shape: colourways with uneven revision histories', () => {
  const out = _latestPerColour([
    '#000150A', '#000150A2',          // red, revised once
    '#000150B',                        // black, untouched
    '#000150C', '#000150C2', '#000150C3', // white, revised twice
  ]);
  assert.deepStrictEqual(out, ['#000150A2', '#000150B', '#000150C3']);
  assert.strictEqual(out.length, 3, 'three colourways → three tiles, not six');
});

test('orders by design then colour, so the client reads them in sequence', () => {
  const out = _latestPerColour(['#000150C', '#000149A', '#000150A']);
  assert.deepStrictEqual(out, ['#000149A', '#000150A', '#000150C']);
});

test('compares versions numerically, not lexically', () => {
  assert.deepStrictEqual(_latestPerColour(['#000150A2', '#000150A10']), ['#000150A10']);
});

test('separates lanes across different designs', () => {
  // #000149A and #000150A are colour A of two DIFFERENT projects/designs —
  // collapsing them together would hide one entirely.
  assert.deepStrictEqual(
    _latestPerColour(['#000149A', '#000150A']),
    ['#000149A', '#000150A'],
  );
});

test('passes through external promo shots untouched', () => {
  // Nothing can be inferred about an unparseable name, so nothing is dropped.
  const out = _latestPerColour(['#000150A', 'Plastic Grinder', 'Lighter']);
  assert.strictEqual(out.length, 3);
  assert.ok(out.includes('Plastic Grinder'));
  assert.ok(out.includes('Lighter'));
  assert.strictEqual(out[0], '#000150A', 'numbered designs lead');
});

test('handles empty and missing input', () => {
  assert.deepStrictEqual(_latestPerColour([]), []);
  assert.deepStrictEqual(_latestPerColour(null), []);
  assert.deepStrictEqual(_latestPerColour(undefined), []);
});

test('is idempotent', () => {
  const once = _latestPerColour(['#000150A', '#000150A2', '#000150B']);
  assert.deepStrictEqual(_latestPerColour(once), once);
});

test('a single design with no revisions is unchanged', () => {
  assert.deepStrictEqual(_latestPerColour(['#000200A']), ['#000200A']);
});

// ── Which designs reach the client ───────────────────────────────────────────
//
// The owner's project panel and the client's "your mockups" list are two views
// of one thing. When they disagree it reads as a broken link: "it only shows 4
// mockups on the client link but the project tab has several more."

const lib = (mockupNum, extra = {}) => ({
  name: 'LIS Boatworks Merch',
  thumbnail: 'data:png',
  pageState: { mockupNum },
  ...extra,
});
const PROJECT = { projectNumber: '145', companyKey: 'longislandsoundcustomboatworks' };

test('a design linked to the project shows', () => {
  const { projectRefs } = _clientDesigns(PROJECT, [lib('#000145A', { projectNumber: '145' })]);
  assert.deepStrictEqual(projectRefs, ['#000145A']);
});

test('the reported bug: a variation the owner can see, the client cannot', () => {
  // "Add a variation" wrote its clone straight to the collection and stamped
  // neither key, so the design carried only pageState.projectNumber — enough for
  // the Studio panel (which reads the blob) and invisible to a client page that
  // read only the field. Eight in the project, four on the link.
  const scoped = [
    lib('#000145A', { projectNumber: '145' }),                  // made in the lab
    lib('#000145B', { pageState: { mockupNum: '#000145B', projectNumber: '145' } }), // variation
  ];
  const { projectRefs } = _clientDesigns(PROJECT, scoped);
  assert.deepStrictEqual(projectRefs, ['#000145A', '#000145B'],
    'the blob is the fallback link, exactly as the Designs panel reads it');
});

test('a design with NO link at all still shows when the order lists it', () => {
  // The owner's own explicit link (picker / lab / promo upload / carry). An
  // unlinked library item belongs to nobody, so honouring the order's list takes
  // nothing from another project.
  const scoped = [lib('#000145C')];
  const { projectRefs } = _clientDesigns(
    { ...PROJECT, mockupNumbers: ['#000145C'] },
    scoped,
  );
  assert.deepStrictEqual(projectRefs, ['#000145C']);
});

test('but ANOTHER project\'s design is never pulled in by the order\'s list', () => {
  // The leak this whole boundary exists to stop: the old fuzzy client-name
  // matcher stuffed order.mockupNumbers with everything the client ever had, and
  // mockupHealth still reports that residue as `conflicting`. A number whose item
  // belongs elsewhere is refused no matter who claims it.
  const scoped = [
    lib('#000145A', { projectNumber: '145' }),
    lib('#000099Z', { projectNumber: '99' }),          // last year's job
  ];
  const { projectRefs } = _clientDesigns(
    { ...PROJECT, mockupNumbers: ['#000145A', '#000099Z'] },
    scoped,
  );
  assert.deepStrictEqual(projectRefs, ['#000145A']);
});

test('the union never double-counts a design both sides list', () => {
  const scoped = [lib('#000145A', { projectNumber: '145' })];
  const { projectRefs } = _clientDesigns({ ...PROJECT, mockupNumbers: ['#000145A'] }, scoped);
  assert.deepStrictEqual(projectRefs, ['#000145A']);
});

test('revision collapsing still applies across the whole union', () => {
  // #145A2 is the second EDIT of colour A — the client sees the current proof,
  // not the one they were already talked out of, however it got into the list.
  const scoped = [
    lib('#000145A', { projectNumber: '145' }),
    lib('#000145A2', { pageState: { mockupNum: '#000145A2', projectNumber: '145' } }),
  ];
  const { projectRefs } = _clientDesigns({ ...PROJECT, mockupNumbers: ['#000145A'] }, scoped);
  assert.deepStrictEqual(projectRefs, ['#000145A2']);
});

test('an order with no project number shows only what it explicitly lists', () => {
  // '' must never match every unlinked mockup in the client's library.
  const scoped = [lib('#000145A'), lib('#000145B')];
  const { projectRefs } = _clientDesigns({ companyKey: 'x', mockupNumbers: ['#000145B'] }, scoped);
  assert.deepStrictEqual(projectRefs, ['#000145B']);
});

test('resolves a reference to THIS project\'s copy of a carried-over design', () => {
  // A carry re-letters under the new project but keeps the design's NAME, so an
  // item referenced by name alone matches on both jobs. The client must get the
  // copy that belongs to the job in front of them, not the older one.
  const old = { name: 'Boat Logo Tee', thumbnail: 'OLD', pageState: {}, projectNumber: '99' };
  const now = { name: 'Boat Logo Tee', thumbnail: 'NEW', pageState: {}, projectNumber: '145' };
  const { byNorm } = _clientDesigns(PROJECT, [old, now]);
  assert.strictEqual(byNorm['BOAT LOGO TEE'].thumbnail, 'NEW');
  // …and the order of the two in the library must not decide it.
  assert.strictEqual(_clientDesigns(PROJECT, [now, old]).byNorm['BOAT LOGO TEE'].thumbnail, 'NEW');
});

test('a real number always outranks a name that normalizes the same way', () => {
  const numbered = lib('#000145A', { name: 'zzz', projectNumber: '145' });
  const named = { name: '145A', thumbnail: 'NAMED', pageState: {}, projectNumber: '145' };
  const { byNorm } = _clientDesigns(PROJECT, [named, numbered]);
  assert.strictEqual(byNorm['145A'], numbered);
});

test('handles an empty library and a missing order', () => {
  assert.deepStrictEqual(_clientDesigns(PROJECT, []).projectRefs, []);
  assert.deepStrictEqual(_clientDesigns(PROJECT, null).projectRefs, []);
  assert.deepStrictEqual(_clientDesigns(null, [lib('#000145A')]).projectRefs, []);
});


// ── Which designs reach the client ───────────────────────────────────────────
// Order.mockupNumbers is the owner's curated, ordered pick. It used to be
// UNIONED with every design on the project, so the pick could only ever add —
// there was no way to show a client three of the eight proofs a job had
// accumulated. A curation is a choice, including what it leaves out.


test('a curated pick is the whole answer — unpicked designs stay off the link', () => {
  const order = { projectNumber: '150', mockupNumbers: ['#000150A', '#000150C'] };
  const items = ['#000150A', '#000150B', '#000150C', '#000150D'].map(n => lib(n, { projectNumber: '150' }));
  const { projectRefs } = _clientDesigns(order, items);
  assert.deepStrictEqual(projectRefs, ['#000150A', '#000150C']);
});

test('with nothing picked, every design on the project still shows', () => {
  // The fallback that keeps existing orders rendering as they do today, and
  // stops an empty selection shipping a confirmation with no artwork.
  const order = { projectNumber: '150', mockupNumbers: [] };
  const items = ['#000150A', '#000150B'].map(n => lib(n, { projectNumber: '150' }));
  const { projectRefs } = _clientDesigns(order, items);
  assert.deepStrictEqual(projectRefs, ['#000150A', '#000150B']);
});

test('a curated pick still collapses each colour to its latest edit', () => {
  const order = { projectNumber: '150', mockupNumbers: ['#000150A', '#000150A2'] };
  const items = ['#000150A', '#000150A2', '#000150B'].map(n => lib(n, { projectNumber: '150' }));
  const { projectRefs } = _clientDesigns(order, items);
  assert.deepStrictEqual(projectRefs, ['#000150A2'], 'the superseded proof stays hidden');
});

test('a curated lane still advances to its latest edit', () => {
  // The pick names colour A of design 150; A has since been revised to A2. The
  // client must see the CURRENT proof of the lane they were shown, never the
  // one they were already talked out of.
  const order = { projectNumber: '150', mockupNumbers: ['#000150A'] };
  const items = ['#000150A', '#000150A2', '#000150B'].map(n => lib(n, { projectNumber: '150' }));
  const { projectRefs } = _clientDesigns(order, items);
  assert.deepStrictEqual(projectRefs, ['#000150A2'], 'the revision follows the lane; colour B stays out');
});
