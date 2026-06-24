// controllers/__tests__/fieldTrackerImport.test.js
//
// Pure-logic checks for the field-tracker import mapper (no DB). Runs on Node's
// built-in test runner:
//
//   node --test controllers/__tests__/fieldTrackerImport.test.js
//
// These PIN the import-correctness fixes from the CRM overhaul:
//   • dead/junk rows are skipped (with a categorized reason)
//   • mapStatus falls back to 'lead' (not 'contacted') for unknown status
//   • the dedup matchKey strips corporate suffixes WITHOUT false-merging
//     genuinely different names (Acme Inc == Acme, Inc. ; Bleu Leaf != Bleu Leaf
//     Dispensary)
//   • multi-value phone/email/name cells parse into multiple contacts
//   • the assumed year defaults to the current year
//   • a single structured import log line (not per-field noise)

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mapTrackerRow, matchKey, deriveCompanyKey, mapStatus, statusImpliesDead,
  extractDateInfo, allPhones, allEmails, normPhone, normEmail, buildContacts,
} = require('../../utils/fieldTrackerImport');

// Build a canonical-keyed row (what mapTrackerRow consumes).
const row = (over = {}) => ({
  companyName: 'Acme', contact: '', phone: '', email: '', area: '',
  interested: '', status: '', lastContact: '', nextContact: '',
  nextAction: '', notes: '', ...over,
});

// ── matchKey: the dedup fix (no false-merge, no false-split) ──────────────────
test('matchKey unifies corporate-suffix variants of the SAME name', () => {
  assert.equal(matchKey('Acme Inc'), matchKey('Acme, Inc.'));
  assert.equal(matchKey('Acme Inc'), matchKey('Acme'));
  assert.equal(matchKey('Joe’s Smoke Co'), matchKey('Joes Smoke'));
  assert.equal(matchKey('Green Leaf LLC'), matchKey('Green Leaf, L.L.C.'));
});

test('matchKey does NOT merge genuinely different companies (no false-merge)', () => {
  // The whole point of the fix: a longer distinct name stays separate.
  assert.notEqual(matchKey('Bleu Leaf'), matchKey('Bleu Leaf Dispensary'));
  assert.notEqual(matchKey('Acme'), matchKey('Acme West'));
  assert.notEqual(matchKey('Incognito'), matchKey('In')); // 'inc' not stripped mid-word
});

test('matchKey keeps a mid-word "inc"/"co" intact (only a trailing suffix strips)', () => {
  // "Incognito" must not lose its leading "inc"; "Coca" must not lose "co".
  assert.equal(matchKey('Incognito'), 'incognito');
  assert.equal(matchKey('Coca Cola'), 'cocacola');
});

test('companyKey (identity) is NOT loosened — different names stay distinct', () => {
  // Identity is the order-linking key; loosening it would silently MERGE
  // companies. Acme Inc and Acme have DIFFERENT identity keys (that is correct;
  // the merge is an explicit owner action via matchKey grouping).
  assert.notEqual(deriveCompanyKey('Acme Inc', ''), deriveCompanyKey('Acme', ''));
  assert.equal(deriveCompanyKey('Acme Inc', ''), 'acmeinc');
});

// ── mapStatus: 'lead' fallback, 'contacted' only on a real touch ──────────────
test('mapStatus falls back to lead (NOT contacted) for unknown status', () => {
  assert.equal(mapStatus('saw their truck'), 'lead');
  assert.equal(mapStatus('maybe later'), 'lead');
  assert.equal(mapStatus(''), null);
});

test('mapStatus only promotes to contacted on a positive/past-tense touch', () => {
  assert.equal(mapStatus('Visited'), 'contacted');
  assert.equal(mapStatus('spoke to manager'), 'contacted');
  assert.equal(mapStatus('emailed them back'), 'contacted'); // past-tense email touch
  // A bare TODO ("call back") is NOT proof of contact.
  assert.equal(mapStatus('call back next week'), 'lead');
  assert.equal(mapStatus('email them'), 'lead');
});

test('mapStatus maps closed/dead vocab to lost, deals to won', () => {
  assert.equal(mapStatus('not interested'), 'lost');
  assert.equal(mapStatus('left vm'), 'lost');
  assert.equal(mapStatus('placed an order!'), 'won');
  assert.equal(mapStatus('quoting now'), 'quoting');
});

test('mapStatus does NOT misread a negated sale ("won\'t reorder") as won', () => {
  assert.equal(mapStatus("won't reorder"), 'lost');
  assert.equal(mapStatus('wont buy'), 'lost');
  assert.equal(mapStatus('cancelled order'), 'lost');
  assert.equal(mapStatus("didn't order"), 'lost');
  // A genuine sale still maps to won.
  assert.equal(mapStatus('won the deal'), 'won');
  assert.equal(mapStatus('reorder placed'), 'won');
});

test('statusImpliesDead recognizes the non-contact vocabulary', () => {
  for (const s of ['No Answer', 'left vm', 'DNC', 'wrong number', 'closed', 'out of business']) {
    assert.equal(statusImpliesDead(s), true, s);
  }
  assert.equal(statusImpliesDead('visited'), false);
});

// ── dead-row skipping ─────────────────────────────────────────────────────────
test('mapTrackerRow skips a dead-status row with no future follow-up', () => {
  const m = mapTrackerRow(row({ status: 'not interested' }));
  assert.equal(m._skip, true);
  assert.equal(m._skipReason, 'dead');
});

test('mapTrackerRow skips "interested? = no"', () => {
  const m = mapTrackerRow(row({ interested: 'no' }));
  assert.equal(m._skip, true);
  assert.equal(m._skipReason, 'dead');
});

test('a dead status WITH a real future follow-up is KEPT (owner scheduled it)', () => {
  const m = mapTrackerRow(row({ status: 'left vm', nextContact: 'call 7/15' }));
  assert.equal(m._skip, false);
  assert.ok(m.nextFollowUp instanceof Date);
});

test('a blank company name is skipped as no-company', () => {
  const m = mapTrackerRow(row({ companyName: '' }));
  assert.equal(m._skip, true);
  assert.equal(m._skipReason, 'no-company');
});

// ── multi-value contact parsing + normalization ───────────────────────────────
test('allPhones splits a multi-number cell and drops junk', () => {
  const ps = allPhones('(201) 555-1212, c: 555-313-1414; on paper');
  assert.equal(ps.length, 2);
});

test('normPhone/normEmail canonicalize for matching (drops US country code)', () => {
  assert.equal(normPhone('+1 (201) 555-1212'), '2015551212');
  assert.equal(normPhone('201.555.1212'), '2015551212');
  assert.equal(normPhone('nope'), '');
  assert.equal(normEmail(' Foo@Bar.COM '), 'foo@bar.com');
  assert.equal(normEmail('not-an-email'), '');
});

test('allEmails pulls multiple addresses, de-duped + lowercased', () => {
  const es = allEmails('A@x.com, b@y.com; A@X.com and c@z.io');
  assert.deepEqual(es, ['a@x.com', 'b@y.com', 'c@z.io']);
});

test('buildContacts zips parallel name/phone/email columns', () => {
  const cs = buildContacts('Ann, Bob', '201-555-1111, 201-555-2222', 'ann@x.com, bob@x.com');
  assert.equal(cs.length, 2);
  assert.equal(cs[0].name, 'Ann');
  assert.equal(normPhone(cs[0].phone), '2015551111');
  assert.equal(cs[1].email, 'bob@x.com');
});

test('extra phones/emails become their own contacts (nothing dropped)', () => {
  const cs = buildContacts('Ann', '201-555-1111, 201-555-2222', 'ann@x.com');
  // Ann + one extra bare-phone contact.
  assert.equal(cs.length, 2);
  assert.equal(cs[0].name, 'Ann');
  assert.equal(normPhone(cs[1].phone), '2015552222');
});

test('mapTrackerRow surfaces multiple contacts on the patch', () => {
  const m = mapTrackerRow(row({ contact: 'Ann and Bob', phone: '201-555-1111, 201-555-2222', email: 'ann@x.com, bob@x.com' }));
  assert.equal(m.contacts.length, 2);
  assert.equal(m.phone, '201-555-1111'); // top-level primary preserved
});

// ── dates: current-year default + ambiguity surfacing ─────────────────────────
test('extractDateInfo defaults a bare M/D to the given year and is not ambiguous', () => {
  const info = extractDateInfo('texted 6/9', 2026);
  assert.equal(info.ambiguous, false);
  assert.equal(info.date.getUTCFullYear(), 2026);
  assert.equal(info.date.getUTCMonth(), 5); // June
  assert.equal(info.date.getUTCDate(), 9);
});

test('mapTrackerRow defaults the assumed year to the CURRENT year', () => {
  const m = mapTrackerRow(row({ status: 'visited', lastContact: 'stopped by 3/2' }));
  assert.equal(m.lastContact.getUTCFullYear(), new Date().getUTCFullYear());
});

test('extractDateInfo flags an unparseable/ambiguous date instead of silently nulling', () => {
  const info = extractDateInfo('next week sometime', 2026);
  assert.equal(info.date, null);
  assert.equal(info.ambiguous, true);
});

test('mapTrackerRow collects ambiguous dates for the result surface', () => {
  const m = mapTrackerRow(row({ status: 'visited', nextContact: 'early next month' }));
  assert.ok(m.ambiguousDates.length >= 1);
});

// ── single structured log line ────────────────────────────────────────────────
test('mapTrackerRow emits ONE structured import line (not per-field noise)', () => {
  const m = mapTrackerRow(row({ status: 'Visited', lastContact: '6/9', nextContact: '6/20' }));
  const imports = m.logs.filter((l) => l.kind === 'import');
  assert.equal(imports.length, 1);
  assert.match(imports[0].text, /Imported from field tracker/);
  // The per-field metadata is folded INTO that one line, not separate rows.
  assert.match(imports[0].text, /status "Visited"/);
  // And it carries a stable per-company dedupKey so re-import can recognize it.
  assert.ok(imports[0].dedupKey);
});
