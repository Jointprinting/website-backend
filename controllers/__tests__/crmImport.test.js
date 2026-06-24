// controllers/__tests__/crmImport.test.js
//
// Pure-logic checks for the CRM import/merge/finance-scope policy (no DB). The
// controller delegates each policy to a pure helper exported for exactly this:
//   • applyImportToDoc        — the re-import merge rules (idempotency)
//   • foldMergeFields         — the survivor fold on a merge
//   • scopeCompanyTransactions— the finance LEAK fix (company-scoped Tx)
//   • pickSurvivor            — duplicate survivor choice
//   • proposeImportMerges     — duplicate detection in an import batch
//
//   node --test controllers/__tests__/crmImport.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyImportToDoc, foldMergeFields, scopeCompanyTransactions,
  pickSurvivor, proposeImportMerges, mergeContacts, ownerTouched,
} = require('../crm');

// A doc-like POJO (applyImportToDoc treats arrays in place like a mongoose doc).
const doc = (over = {}) => ({
  companyKey: 'acme', companyName: '', matchKey: '', area: '', phone: '', email: '',
  interestType: '', source: '', stage: 'lead', dealValue: 0, tags: [], notes: '',
  lastContact: null, nextFollowUp: null, contacts: [], log: [], ...over,
});
const mapped = (over = {}) => ({
  companyKey: 'acme', companyName: 'Acme', matchKey: 'acme', area: '', phone: '',
  email: '', interestType: '', stage: null, lastContact: null, nextFollowUp: null,
  contacts: [], logs: [], ...over,
});
const D = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12));

// ── IDEMPOTENT RE-IMPORT: never move an existing nextFollowUp ──────────────────
test('re-import NEVER moves an existing nextFollowUp (owner reschedule survives)', () => {
  const existing = doc({ nextFollowUp: D(2026, 7, 1) }); // owner pushed it to July 1
  // Import wants an earlier date — must NOT win on an existing record.
  applyImportToDoc(existing, mapped({ nextFollowUp: D(2026, 6, 10) }), /* isNew */ false);
  assert.deepEqual(existing.nextFollowUp, D(2026, 7, 1));
});

test('re-import never resurrects a follow-up the owner CLEARED', () => {
  const existing = doc({ nextFollowUp: null }); // owner cleared it
  applyImportToDoc(existing, mapped({ nextFollowUp: D(2026, 6, 10) }), false);
  assert.equal(existing.nextFollowUp, null);
});

test('nextFollowUp IS seeded on record CREATE', () => {
  const fresh = doc({ nextFollowUp: null });
  applyImportToDoc(fresh, mapped({ nextFollowUp: D(2026, 6, 10) }), /* isNew */ true);
  assert.deepEqual(fresh.nextFollowUp, D(2026, 6, 10));
});

test('re-import never downgrades an owner-advanced stage', () => {
  const existing = doc({ stage: 'quoting' });
  applyImportToDoc(existing, mapped({ stage: 'contacted' }), false);
  assert.equal(existing.stage, 'quoting'); // not regressed
});

test('re-import DOES fill a default-stage record from the import', () => {
  const existing = doc({ stage: 'lead' });
  applyImportToDoc(existing, mapped({ stage: 'contacted' }), false);
  assert.equal(existing.stage, 'contacted');
});

test('re-import fills blanks only — never clobbers a non-empty field', () => {
  const existing = doc({ phone: '201-555-0000', area: 'North Jersey' });
  applyImportToDoc(existing, mapped({ phone: '201-555-9999', area: '', companyName: 'Acme' }), false);
  assert.equal(existing.phone, '201-555-0000'); // kept
  assert.equal(existing.area, 'North Jersey');  // kept
  assert.equal(existing.companyName, 'Acme');   // filled (was blank)
});

test('lastContact is a monotonic high-water mark (newer-of)', () => {
  const existing = doc({ lastContact: D(2026, 6, 1) });
  applyImportToDoc(existing, mapped({ lastContact: D(2026, 5, 1) }), false);
  assert.deepEqual(existing.lastContact, D(2026, 6, 1)); // older import ignored
  applyImportToDoc(existing, mapped({ lastContact: D(2026, 6, 20) }), false);
  assert.deepEqual(existing.lastContact, D(2026, 6, 20)); // newer import wins
});

// ── CONTACT MATCH by phone OR email + merge (no duplicate spawning) ────────────
test('re-import matches an existing contact by EMAIL and merges blanks', () => {
  const existing = doc({ contacts: [{ name: '', role: '', phone: '', email: 'ann@x.com' }] });
  applyImportToDoc(existing, mapped({ contacts: [{ name: 'Ann', role: 'buyer', phone: '201-555-1', email: 'ann@x.com' }] }), false);
  assert.equal(existing.contacts.length, 1);          // merged, not appended
  assert.equal(existing.contacts[0].name, 'Ann');     // blank filled
  assert.equal(existing.contacts[0].role, 'buyer');
});

test('re-import matches an existing contact by PHONE (country-code-insensitive)', () => {
  const existing = doc({ contacts: [{ name: 'Ann', role: '', phone: '(201) 555-1212', email: '' }] });
  applyImportToDoc(existing, mapped({ contacts: [{ name: 'Ann', role: '', phone: '+1 201 555 1212', email: 'ann@x.com' }] }), false);
  assert.equal(existing.contacts.length, 1);
  assert.equal(existing.contacts[0].email, 'ann@x.com'); // merged in
});

test('a genuinely new contact IS appended', () => {
  const existing = doc({ contacts: [{ name: 'Ann', phone: '201-555-1', email: 'ann@x.com' }] });
  applyImportToDoc(existing, mapped({ contacts: [{ name: 'Bob', phone: '201-555-2', email: 'bob@x.com' }] }), false);
  assert.equal(existing.contacts.length, 2);
});

// ── LOG NOISE: single import line, de-duped on re-import ───────────────────────
test('re-importing the same row does not pile up duplicate log lines', () => {
  const existing = doc();
  const logs = [{ kind: 'import', text: 'Imported from field tracker — status "Visited"', dedupKey: 'import:acme' }];
  applyImportToDoc(existing, mapped({ logs }), false);
  applyImportToDoc(existing, mapped({ logs }), false); // re-import
  const imports = existing.log.filter((l) => l.kind === 'import');
  assert.equal(imports.length, 1);
});

// ── FINANCE LEAK FIX: company-scoped transactions ─────────────────────────────
test('scopeCompanyTransactions drops a colliding order number owned by another company', () => {
  // Both "Acme" and "Beta" have order #21. Our company is Acme.
  const rows = [
    { type: 'income', category: 'Customer Sales', amount: 100, orderNumber: '21', party: 'Acme' },
    { type: 'income', category: 'Customer Sales', amount: 999, orderNumber: '21', party: 'Beta Co' }, // NOT ours
  ];
  const scoped = scopeCompanyTransactions(rows, {
    ownNames: new Set(['acme']),
    sharedNums: new Set(['21']), // #21 collides across companies
  });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].amount, 100);
});

test('scopeCompanyTransactions counts a uniquely-ours number regardless of party text', () => {
  const rows = [{ type: 'income', category: 'Customer Sales', amount: 100, orderNumber: '7', party: '' }];
  const scoped = scopeCompanyTransactions(rows, { ownNames: new Set(['acme']), sharedNums: new Set() });
  assert.equal(scoped.length, 1); // not shared → always counts
});

test('scopeCompanyTransactions leaves out a collided row with a blank party (can’t attribute)', () => {
  const rows = [{ type: 'income', category: 'Customer Sales', amount: 100, orderNumber: '21', party: '' }];
  const scoped = scopeCompanyTransactions(rows, { ownNames: new Set(['acme']), sharedNums: new Set(['21']) });
  assert.equal(scoped.length, 0); // under-count beats stealing another company's money
});

test('scopeCompanyTransactions keeps OUR row when the party carries a corp suffix (matchKey-normalized)', () => {
  // Our Order says "Acme"; our ledger row's party reads "Acme LLC". With the
  // matchKey nameKey both normalize to "acme", so the row is correctly kept even
  // though the number collides.
  const { matchKey } = require('../../utils/fieldTrackerImport');
  const rows = [
    { type: 'income', category: 'Customer Sales', amount: 100, orderNumber: '21', party: 'Acme LLC' },
    { type: 'income', category: 'Customer Sales', amount: 999, orderNumber: '21', party: 'Beta Co' },
  ];
  const ownNames = new Set([matchKey('Acme', '')]); // 'acme'
  const scoped = scopeCompanyTransactions(rows, { ownNames, sharedNums: new Set(['21']), nameKey: (s) => matchKey(s, '') });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].amount, 100); // ours kept, Beta dropped
});

// ── MERGE fold (no data loss) ─────────────────────────────────────────────────
test('foldMergeFields preserves both companies’ data into the survivor', () => {
  const survivor = {
    companyKey: 's', companyName: 'Acme', clientName: '', email: '', phone: '201-1',
    area: 'NJ', interestType: '', stage: 'contacted', dealValue: 500, tags: ['vip'],
    notes: 'keep me', lastContact: D(2026, 6, 1), nextFollowUp: D(2026, 7, 1),
    contacts: [{ name: 'Ann', phone: '201-1', email: 'ann@x.com' }], log: [{ at: D(2026, 6, 1), text: 'a', kind: 'call' }],
  };
  const merged = {
    companyKey: 'm', companyName: 'Acme Inc', clientName: 'Acme', email: 'info@acme.com', phone: '201-2',
    area: '', interestType: 'promos', stage: 'quoting', dealValue: 1200, tags: ['wholesale'],
    notes: 'merged note', lastContact: D(2026, 6, 15), nextFollowUp: D(2026, 6, 20),
    contacts: [{ name: 'Bob', phone: '201-2', email: 'bob@x.com' }], log: [{ at: D(2026, 6, 10), text: 'b', kind: 'email' }],
  };
  foldMergeFields(survivor, merged, 'm');

  assert.equal(survivor.email, 'info@acme.com');       // blank filled
  assert.equal(survivor.phone, '201-1');               // kept (non-blank)
  assert.equal(survivor.interestType, 'promos');       // filled
  assert.equal(survivor.dealValue, 1200);              // larger, not summed
  assert.equal(survivor.stage, 'quoting');             // further along
  assert.deepEqual(survivor.lastContact, D(2026, 6, 15)); // newer
  assert.deepEqual(survivor.nextFollowUp, D(2026, 7, 1)); // survivor's kept
  assert.deepEqual([...survivor.tags].sort(), ['vip', 'wholesale']); // union
  assert.match(survivor.notes, /keep me/);
  assert.match(survivor.notes, /merged note/);          // both notes kept
  assert.equal(survivor.contacts.length, 2);            // both people kept
  // both log lines + a merge breadcrumb, chronologically ordered
  assert.ok(survivor.log.length >= 3);
  assert.ok(survivor.log.some((l) => l.dedupKey === 'merge:m'));
});

test('mergeContacts dedupes by phone/email across the two records', () => {
  const out = mergeContacts(
    [{ name: 'Ann', phone: '201-555-1212', email: '' }],
    [{ name: '', phone: '+1 (201) 555-1212', email: 'ann@x.com' }],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'Ann');
  assert.equal(out[0].email, 'ann@x.com'); // filled
});

// ── pickSurvivor + proposeImportMerges ────────────────────────────────────────
test('pickSurvivor prefers the record that has orders', () => {
  const group = [
    { companyKey: 'a', stage: 'lead', log: [], contacts: [], dealValue: 0, createdAt: D(2026, 1, 1) },
    { companyKey: 'b', stage: 'lead', log: [], contacts: [], dealValue: 0, createdAt: D(2026, 2, 1) },
  ];
  assert.equal(pickSurvivor(group, new Set(['b'])), 'b'); // b has orders
});

test('pickSurvivor falls back to the furthest stage when neither has orders', () => {
  const group = [
    { companyKey: 'a', stage: 'lead', log: [], contacts: [], dealValue: 0, createdAt: D(2026, 1, 1) },
    { companyKey: 'b', stage: 'quoting', log: [], contacts: [], dealValue: 0, createdAt: D(2026, 2, 1) },
  ];
  assert.equal(pickSurvivor(group, new Set()), 'b');
});

test('proposeImportMerges flags rows sharing a matchKey but with different identity', () => {
  const rows = [
    { _skip: false, matchKey: 'acme', companyKey: 'acme', companyName: 'Acme' },
    { _skip: false, matchKey: 'acme', companyKey: 'acmeinc', companyName: 'Acme Inc' },
    { _skip: false, matchKey: 'beta', companyKey: 'beta', companyName: 'Beta' },
  ];
  const proposed = proposeImportMerges(rows, new Map());
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].matchKey, 'acme');
  assert.equal(proposed[0].members.length, 2);
});

test('proposeImportMerges folds in an existing DB record sharing the matchKey', () => {
  const rows = [{ _skip: false, matchKey: 'acme', companyKey: 'acmeinc', companyName: 'Acme Inc' }];
  const existing = new Map([['acme', [{ companyKey: 'acme', companyName: 'Acme' }]]]);
  const proposed = proposeImportMerges(rows, existing);
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].members.length, 2); // import row + existing stub
});

// ── ownerTouched (replace-mode safety) ────────────────────────────────────────
test('ownerTouched protects records with real activity from replace-archiving', () => {
  assert.equal(ownerTouched({ stage: 'quoting', log: [], tags: [] }), true);  // advanced stage
  assert.equal(ownerTouched({ stage: 'lead', dealValue: 500, log: [], tags: [] }), true); // money
  assert.equal(ownerTouched({ stage: 'lead', log: [{ kind: 'call' }], tags: [] }), true); // human touch
  assert.equal(ownerTouched({ stage: 'lead', log: [{ kind: 'import' }], tags: [], notes: '' }), false); // pure import
});
