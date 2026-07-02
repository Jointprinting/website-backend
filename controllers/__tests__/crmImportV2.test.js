// controllers/__tests__/crmImportV2.test.js
//
// Pure-logic checks for the CRM v2 import upgrades (no DB):
//   • multi-format header detection (field tracker / Notion / Google sheet)
//   • status/temperature vocabulary → stage + tag (Nate's real Notion values)
//   • order → customer promotion (promote-UP-only, never regress)
//   • delete-one-log-entry (by id + legacy index fallback)
//   • ISO (YYYY-MM-DD) date parsing
//   • global search $or (contacts/tags/identity)
//   • keep-cold/keep-lost for CRM-DB sources; field-tracker still dead-skips
//
//   node --test controllers/__tests__/crmImportV2.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCsv, locateHeader, detectFormat, canonHeader, normHeader,
  rowsToObjectsWithMeta, mapTrackerRow, mapStatus, statusTemperature,
  engagementTag, orderStatusImpliesOrder, parseMoney, extractDateInfo,
  parseTrackerCsv,
} = require('../../utils/fieldTrackerImport');

const {
  applyImportToDoc, promoteStage, removeLogEntry, searchOr, normalizeRowKeys,
  classifyHeadsUp, buildHeadsUp, ownerTouched, buildMappedRows,
} = require('../crm');

const { PLACED_STATUSES } = require('../../models/Order');
const { isPlacedStatus } = require('../orders');

// ── Header normalization & alias resolution ──────────────────────────────────
test('normHeader strips case / spaces / punctuation uniformly', () => {
  assert.equal(normHeader('Owner / Contact'), 'ownercontact');
  assert.equal(normHeader('Next Follow-up'), 'nextfollowup');
  assert.equal(normHeader('Order #'), 'order');
  assert.equal(normHeader('Interested?'), 'interested');
  assert.equal(normHeader('  Last Contact Date '), 'lastcontactdate');
});

test('canonHeader maps each source\'s headers to the canonical column', () => {
  // Notion
  assert.equal(canonHeader('Contact Person'), 'contact');
  assert.equal(canonHeader('Contact Email'), 'email');
  assert.equal(canonHeader('Contact Phone'), 'phone');
  assert.equal(canonHeader('Next Follow-up'), 'nextContact');
  assert.equal(canonHeader('Last Contact Date'), 'lastContact');
  assert.equal(canonHeader('Order Number'), 'orderNumber');
  // Google sheet
  assert.equal(canonHeader('Best POC'), 'contact');
  assert.equal(canonHeader('Client Name'), 'clientName');
  assert.equal(canonHeader('Order #'), 'orderNumber');
  assert.equal(canonHeader('Next'), 'nextContact');
  assert.equal(canonHeader('Stage'), 'status');
  // junk columns ignored
  assert.equal(canonHeader(' 1'), '');
  assert.equal(canonHeader(' 14'), '');
});

// ── Format detection on real-shaped headers ──────────────────────────────────
test('detects the Notion CRM export by its headers', () => {
  const csv = [
    'Company Name,Contact Person,Contact Email,Contact Phone,Status,Order Number,Notes,Last Contact Date,Next Follow-up',
    'Acme Co,Jane Doe,jane@acme.com,201-555-1212,Warm (Leads),,hot lead,2026-06-01,2026-06-25',
  ].join('\n');
  const { format, rows } = rowsToObjectsWithMeta(parseCsv(csv));
  assert.equal(format, 'notion');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].companyName, 'Acme Co');
  assert.equal(rows[0].nextContact, '2026-06-25');
});

test('detects the Google CRM sheet (loose headers, no title row)', () => {
  const csv = [
    'Order #,Client Name,Company Name,Best POC,Stage,Last Contact,Next Contact',
    '21,Jane Doe,Acme Co,Bob,Warm,2026-05-01,2026-06-20',
  ].join('\n');
  const { format, rows } = rowsToObjectsWithMeta(parseCsv(csv));
  assert.equal(format, 'google-sheet');
  assert.equal(rows[0].orderNumber, '21');
  assert.equal(rows[0].contact, 'Bob');
});

test('still detects the legacy field-visit tracker (title row above headers)', () => {
  const csv = [
    'Field Visit Tracker,,,,,,,,,',
    'Company Name,Owner / Contact,Phone,Email,Area,Interested?,Status,Last Contact,Next Contact,Next Action,Notes',
    'Bleu Leaf,Sam,201-555-0000,,North Jersey,promos,Visited,6/1,6/20,follow up,nice shop',
  ].join('\n');
  const { format, rows } = rowsToObjectsWithMeta(parseCsv(csv));
  assert.equal(format, 'field-tracker');
  assert.equal(rows[0].companyName, 'Bleu Leaf');
  assert.equal(rows[0].interested, 'promos');
});

// ── Status / temperature vocabulary → stage + tag ────────────────────────────
test('Nate\'s exact Notion Status values map to the right stage + tag', () => {
  const cases = [
    // NEW CONTRACT: a status WORD never yields 'customer' — that's reserved for a
    // verified placed Order. "Hot (Clients)" is just warmth (→ contacted, tag hot);
    // "Orders In Progress" is in-flight (→ quoting, tag in-progress).
    ['Hot (Clients)',             'contacted', 'hot'],
    ['Won Orders',                'won',       'won'],
    ['Orders In Progress',        'quoting',   'in-progress'],
    ['Warm (Leads)',              'contacted', 'warm'],
    ['Room Temp (Opportunities)', 'contacted', 'room-temp'],
    ['Cold (Prospects)',          'lead',      'cold'],
    ['Lost Orders',               'dormant',   'lost'],
    ['Meta Ad Conversions',       'lead',      'meta-ad'],
  ];
  for (const [raw, stage, tag] of cases) {
    assert.equal(mapStatus(raw), stage, `stage for "${raw}"`);
    const seg = statusTemperature(raw);
    assert.ok(seg && seg.tag === tag, `tag for "${raw}" expected ${tag}, got ${seg && seg.tag}`);
  }
});

test('loose sheet temperature words still map (hot/warm/cold/opportunity)', () => {
  assert.equal(mapStatus('hot'), 'quoting');
  assert.equal(mapStatus('warm'), 'contacted');
  assert.equal(mapStatus('cold'), 'lead');
  assert.equal(mapStatus('opportunity'), 'contacted');
  assert.equal(statusTemperature('hot').tag, 'hot');
  assert.equal(statusTemperature('cold').tag, 'cold');
});

test('the Google sheet bare "LOST" Stage/tab value → dormant + tag lost (kept)', () => {
  assert.equal(mapStatus('LOST'), 'dormant');
  assert.equal(statusTemperature('LOST').tag, 'lost');
  // and via a full sheet row (LOST tab, no order) it is KEPT, not skipped
  const m = mapTrackerRow({ clientName: 'Past Co', status: 'LOST' }, { format: 'google-sheet' });
  assert.equal(m._skip, false);
  assert.equal(m.stage, 'dormant');
  assert.ok(m.tags.includes('lost'));
});

test('a sale word beats a bare temperature word in free text (won - was hot → won)', () => {
  // The generic temperature stage is a LAST resort — a real sale/order word wins.
  assert.equal(mapStatus('won - was hot'), 'won');
  assert.equal(mapStatus('hot - placed order'), 'won');
  assert.equal(mapStatus('reorder, still warm'), 'won');
  // but a status that is JUST a temperature word maps by temperature
  assert.equal(mapStatus('hot'), 'quoting');
  assert.equal(mapStatus('warm'), 'contacted');
});

test('Notion/Google JSON rows keep cold/lost; field-tracker JSON still dead-skips', () => {
  const notionRows = buildMappedRows({ rows: [
    { 'Company Name': 'Acme', 'Contact Person': 'Jane', 'Status': 'Cold (Prospects)' },
    { 'Company Name': 'Bygone', 'Contact Person': 'Ed', 'Status': 'no answer' }, // dead word, but Notion-detected → kept
  ] });
  assert.equal(notionRows[0]._skip, false);
  assert.equal(notionRows[0].stage, 'lead');
  assert.ok(notionRows[0].tags.includes('cold'));
  assert.equal(notionRows[1]._skip, false); // kept (CRM-DB source never dead-skips)

  const ftRows = buildMappedRows({ rows: [
    { 'Company Name': 'DeadCo', 'Owner / Contact': 'Bob', 'Interested?': 'no', 'Status': 'not interested', 'Area': 'NJ' },
  ] });
  assert.equal(ftRows[0]._skip, true); // field-tracker shape → dead-skip still applies
  assert.equal(ftRows[0]._skipReason, 'dead');
});

test('negation guard holds against sale words ("won\'t reorder" → lost, not won)', () => {
  assert.equal(mapStatus("won't reorder"), 'lost');
  assert.equal(mapStatus('cancelled order'), 'lost');
  assert.equal(mapStatus("didn't order"), 'lost');
  // the explicit Lost/Cold end-states are kept even though they read "negative"
  assert.equal(mapStatus('Lost Orders'), 'dormant');
  assert.equal(mapStatus('Cold (Prospects)'), 'lead');
});

test('engagementTag maps the Notion Engagement Level', () => {
  assert.equal(engagementTag('High'), 'eng-high');
  assert.equal(engagementTag('Medium'), 'eng-medium');
  assert.equal(engagementTag('Low'), 'eng-low');
  assert.equal(engagementTag('Inactive'), 'eng-inactive');
  assert.equal(engagementTag(''), '');
});

test('orderStatusImpliesOrder detects a real order state (beyond Lead/Lost)', () => {
  for (const s of ['Completed', 'Paid', 'In Transit', 'Invoice Sent', 'Quoting', 'Mockups in Progress']) {
    assert.equal(orderStatusImpliesOrder(s), true, s);
  }
  assert.equal(orderStatusImpliesOrder('Lead'), false);
  assert.equal(orderStatusImpliesOrder('Lost'), false);
  assert.equal(orderStatusImpliesOrder(''), false);
});

// ── parseMoney ───────────────────────────────────────────────────────────────
test('parseMoney parses $ / commas / k-shorthand', () => {
  assert.equal(parseMoney('$2,500'), 2500);
  assert.equal(parseMoney('2500'), 2500);
  assert.equal(parseMoney('2.5k'), 2500);
  assert.equal(parseMoney('1,200.50'), 1200.5);
  assert.equal(parseMoney(''), 0);
  assert.equal(parseMoney('n/a'), 0);
});

// ── ISO date parsing ─────────────────────────────────────────────────────────
test('extractDateInfo parses ISO YYYY-MM-DD at UTC noon (no day shift)', () => {
  const info = extractDateInfo('2026-06-25', 2026);
  assert.ok(info.date instanceof Date);
  assert.equal(info.date.getUTCFullYear(), 2026);
  assert.equal(info.date.getUTCMonth(), 5);  // June
  assert.equal(info.date.getUTCDate(), 25);
  assert.equal(info.date.getUTCHours(), 12); // UTC noon convention
  assert.equal(info.ambiguous, false);
});

test('extractDateInfo still parses the legacy M/D form', () => {
  const info = extractDateInfo('texted 6/9', 2026);
  assert.equal(info.date.getUTCMonth(), 5);
  assert.equal(info.date.getUTCDate(), 9);
  assert.equal(info.date.getUTCHours(), 12);
});

test('a Notion ISO row produces nextFollowUp at UTC noon, bucketing on its day', () => {
  const row = { companyName: 'Acme', nextContact: '2026-06-25', status: 'Warm (Leads)' };
  const m = mapTrackerRow(row, { year: 2026, format: 'notion' });
  assert.equal(m.nextFollowUp.getUTCDate(), 25);
  assert.equal(m.nextFollowUp.getUTCHours(), 12);
});

// ── Order-number HINT (row-level): a free-text order cell is NOT a customer ───
// NEW CONTRACT: a free-text "Order Number"/"Order Status" cell is only a HINT
// (no verified Order doc behind it). The importer NEVER emits stage 'customer' —
// the stage follows the status word, and an 'order-ref' tag records the hint.
// Real customer promotion is owner-approved on placed-order placement (controller).
test('a row carrying an Order Number is a HINT, not a customer (stage follows status)', () => {
  const m = mapTrackerRow(
    { companyName: 'Acme', status: 'Cold (Prospects)', orderNumber: '21' },
    { format: 'notion' },
  );
  assert.equal(m.hasOrderNumber, true);
  assert.notEqual(m.stage, 'customer');  // never customer from a free-text cell
  assert.equal(m.stage, 'lead');         // Cold (Prospects) → lead
  assert.ok(m.tags.includes('order-ref'));
  assert.equal(m._skip, false); // never skipped — order hint always keeps the row
});

test('an Order Status of a real order-state is also just a hint (not customer)', () => {
  const m = mapTrackerRow(
    { companyName: 'Acme', status: 'Warm (Leads)', orderStatus: 'Paid' },
    { format: 'notion' },
  );
  assert.equal(m.hasOrderNumber, true);
  assert.notEqual(m.stage, 'customer');
  assert.equal(m.stage, 'contacted');    // Warm (Leads) → contacted
  assert.ok(m.tags.includes('order-ref'));
});

// ── promoteStage: UP-only, never touches closed/parked ───────────────────────
test('promoteStage moves UP the funnel only', () => {
  assert.equal(promoteStage('lead', 'customer'), 'customer');
  assert.equal(promoteStage('contacted', 'customer'), 'customer');
  assert.equal(promoteStage('lead', 'contacted'), 'contacted');
});

test('promoteStage NEVER regresses an advanced or closed stage', () => {
  assert.equal(promoteStage('won', 'customer'), 'won');        // won stays won
  assert.equal(promoteStage('customer', 'lead'), 'customer');  // no downgrade
  assert.equal(promoteStage('quoting', 'contacted'), 'quoting'); // mid-funnel not pulled back
});

test('promoteStage refuses to touch lost / dormant (deliberate end states)', () => {
  assert.equal(promoteStage('lost', 'customer'), 'lost');
  assert.equal(promoteStage('dormant', 'customer'), 'dormant');
  // and never promotes INTO a closed/parked stage from an order
  assert.equal(promoteStage('lead', 'lost'), 'lead');
});

// NOTE: quoting (rank 2) < customer (rank 5), so an order DOES promote a manual
// mid-funnel stage up to 'customer' — intended (an order outranks mid-funnel).
test('order promotion lifts a mid-funnel stage to customer but not a closed one', () => {
  assert.equal(promoteStage('contacted', 'customer'), 'customer');
  assert.equal(promoteStage('quoting', 'customer'), 'customer');
});

// ── applyImportToDoc: order→customer + tag union + dealValue fill ─────────────
const doc = (over = {}) => ({
  companyKey: 'acme', companyName: '', clientName: '', matchKey: '', area: '', address: '',
  phone: '', email: '', interestType: '', source: '', stage: 'lead', dealValue: 0,
  tags: [], notes: '', lastContact: null, nextFollowUp: null, contacts: [], log: [], ...over,
});
const mapped = (over = {}) => ({
  companyKey: 'acme', companyName: 'Acme', matchKey: 'acme', tags: [], logs: [], contacts: [], ...over,
});

test('applyImportToDoc promotes a lead to customer when the company has orders', () => {
  const d = doc({ stage: 'lead' });
  applyImportToDoc(d, mapped({ stage: 'lead' }), false, { hasOrders: true });
  assert.equal(d.stage, 'customer');
});

test('applyImportToDoc never downgrades an owner-advanced stage on order promotion', () => {
  const d = doc({ stage: 'won' });
  applyImportToDoc(d, mapped({ stage: 'lead' }), false, { hasOrders: true });
  assert.equal(d.stage, 'won'); // not pulled back to customer
});

test('applyImportToDoc unions temperature tags without clobbering owner tags', () => {
  const d = doc({ tags: ['vip'] });
  applyImportToDoc(d, mapped({ tags: ['hot', 'VIP'] }), false, {});
  assert.deepEqual(d.tags, ['vip', 'hot']); // VIP de-duped case-insensitively
});

test('applyImportToDoc fills a blank dealValue but never overwrites an owner value', () => {
  const blank = doc({ dealValue: 0 });
  applyImportToDoc(blank, mapped({ dealValue: 2500 }), false, {});
  assert.equal(blank.dealValue, 2500);

  const owned = doc({ dealValue: 9000 });
  applyImportToDoc(owned, mapped({ dealValue: 2500 }), false, {});
  assert.equal(owned.dealValue, 9000); // kept
});

test('applyImportToDoc fills address blank-only', () => {
  const d = doc({ address: '' });
  applyImportToDoc(d, mapped({ address: '123 Main St' }), false, {});
  assert.equal(d.address, '123 Main St');
});

// ── Keep-cold / keep-lost for CRM-DB sources; tracker still dead-skips ────────
test('Notion Cold/Lost rows are KEPT (not skipped)', () => {
  const cold = mapTrackerRow({ companyName: 'Acme', status: 'Cold (Prospects)' }, { format: 'notion' });
  assert.equal(cold._skip, false);
  assert.equal(cold.stage, 'lead');
  assert.ok(cold.tags.includes('cold'));

  const lost = mapTrackerRow({ companyName: 'Acme', status: 'Lost Orders' }, { format: 'notion' });
  assert.equal(lost._skip, false);
  assert.equal(lost.stage, 'dormant');
  assert.ok(lost.tags.includes('lost'));
});

test('field-tracker dead row with no order and no follow-up STILL skips', () => {
  const m = mapTrackerRow({ companyName: 'Acme', status: 'not interested' }, { format: 'field-tracker' });
  assert.equal(m._skip, true);
  assert.equal(m._skipReason, 'dead');
});

test('field-tracker dead row WITH a future follow-up is kept (owner scheduled it)', () => {
  const m = mapTrackerRow({ companyName: 'Acme', status: 'left vm', nextContact: '2026-06-25' }, { format: 'field-tracker' });
  assert.equal(m._skip, false);
});

test('a row with no company AND no client name is skipped (no identity)', () => {
  const m = mapTrackerRow({ status: 'Warm (Leads)' }, { format: 'notion' });
  assert.equal(m._skip, true);
  assert.equal(m._skipReason, 'no-company');
});

test('Google sheet row keys off Client Name when Company Name is blank', () => {
  const m = mapTrackerRow({ clientName: 'Jane Doe', contact: 'Bob', status: 'Warm' }, { format: 'google-sheet' });
  assert.equal(m._skip, false);
  assert.equal(m.companyKey, 'janedoe');
  assert.equal(m.clientName, 'Jane Doe');
});

// ── normalizeRowKeys (JSON-rows path) recognizes the new headers ─────────────
test('normalizeRowKeys (JSON path) maps Notion + Google headers', () => {
  const out = normalizeRowKeys({
    'Company Name': 'Acme', 'Contact Person': 'Jane', 'Next Follow-up': '2026-06-25',
    'Best POC': 'Bob', 'Order #': '21', ' 1': 'junk',
  });
  assert.equal(out.companyName, 'Acme');
  assert.equal(out.contact, 'Jane');         // Contact Person wins (first), Best POC also maps to contact
  assert.equal(out.nextContact, '2026-06-25');
  assert.equal(out.orderNumber, '21');
  assert.ok(!('junk' in out)); // ' 1' dropped
});

// ── removeLogEntry: by id + legacy index fallback ────────────────────────────
test('removeLogEntry removes the entry whose _id matches', () => {
  const log = [
    { _id: 'a1', text: 'one' },
    { _id: 'b2', text: 'two' },
    { _id: 'c3', text: 'three' },
  ];
  const { next, removed } = removeLogEntry(log, 'b2');
  assert.equal(removed, 1);
  assert.deepEqual(next.map((e) => e.text), ['one', 'three']);
});

test('removeLogEntry falls back to a numeric index for legacy (id-less) entries', () => {
  const log = [{ text: 'one' }, { text: 'two' }, { text: 'three' }]; // no _id
  const { next, removed } = removeLogEntry(log, '1');
  assert.equal(removed, 1);
  assert.deepEqual(next.map((e) => e.text), ['one', 'three']);
});

test('removeLogEntry returns removed:0 when nothing matches', () => {
  const log = [{ _id: 'a1', text: 'one' }];
  assert.equal(removeLogEntry(log, 'zzz').removed, 0);
  assert.equal(removeLogEntry(log, '5').removed, 0); // index out of range
  assert.equal(removeLogEntry([], 'a1').removed, 0);
});

test('removeLogEntry prefers an id match over an index when both could apply', () => {
  // entryId '1' could be index 1, but an entry literally has _id '1' → id wins.
  const log = [{ _id: 'x', text: 'zero' }, { _id: '1', text: 'one-by-id' }, { _id: 'y', text: 'two' }];
  const { next } = removeLogEntry(log, '1');
  // The id-'1' entry ("one-by-id") is removed, NOT index 1 (same here), but the
  // point is determinism: id match first.
  assert.ok(!next.some((e) => e.text === 'one-by-id'));
});

// ── searchOr: global "find anyone" ───────────────────────────────────────────
test('searchOr matches identity, contacts, and tags', () => {
  const or = searchOr('jane');
  assert.ok(Array.isArray(or));
  const fields = or.flatMap((clause) => Object.keys(clause));
  for (const f of ['companyName', 'clientName', 'companyKey', 'email', 'phone', 'tags', 'contacts.name', 'contacts.email', 'contacts.phone']) {
    assert.ok(fields.includes(f), `searchOr should query ${f}`);
  }
});

test('searchOr adds a digits-only phone clause for a numeric query', () => {
  const or = searchOr('(201) 555-1212');
  // at least one clause matches contacts.phone with a digits-only regex
  const phoneClauses = or.filter((c) => c['contacts.phone']);
  assert.ok(phoneClauses.length >= 1);
});

test('searchOr returns null for an empty query (no constraint)', () => {
  assert.equal(searchOr(''), null);
  assert.equal(searchOr('   '), null);
  assert.equal(searchOr(null), null);
});

// ── ownerTouched ignores IMPORT-generated tags (replace-mode stays effective) ─
test('ownerTouched treats import temperature/engagement tags as NOT owner activity', () => {
  // a pure import tagged cold/eng-low by the importer is still "replaceable"
  assert.equal(ownerTouched({ stage: 'lead', tags: ['cold', 'eng-low'], log: [{ kind: 'import' }], notes: '' }), false);
  // but a real owner-added tag (not in the import set) counts as a touch
  assert.equal(ownerTouched({ stage: 'lead', tags: ['cold', 'vip'], log: [], notes: '' }), true);
});

// ── Dashboard heads-up: down-rank cold / never-worked leads ──────────────────
const NOW_MS   = new Date('2026-06-23T18:00:00Z').getTime();
const START_MS = new Date('2026-06-23T00:00:00Z').getTime();
const hu = (c) => classifyHeadsUp(c, NOW_MS, START_MS).map((i) => i.type).sort();

test('a cold-tagged bare lead with nothing scheduled is NOT flagged (down-ranked)', () => {
  const cold = {
    companyKey: 'k', companyName: 'Cold Co', stage: 'lead', dealValue: 0,
    nextFollowUp: null, lastContact: null, tags: ['cold'], log: [], contacts: [],
  };
  assert.deepEqual(hu(cold), []); // no no_next_step / stale noise
});

test('a never-contacted lead (no tag) is also down-ranked', () => {
  const fresh = {
    companyKey: 'k', companyName: 'New Lead', stage: 'lead', dealValue: 0,
    nextFollowUp: null, lastContact: null, tags: [], log: [], contacts: [],
  };
  assert.deepEqual(hu(fresh), []);
});

test('a cold lead the owner DID schedule a follow-up for still surfaces if overdue', () => {
  const scheduled = {
    companyKey: 'k', companyName: 'Cold But Scheduled', stage: 'lead', dealValue: 0,
    nextFollowUp: '2026-06-20', // before today → overdue
    lastContact: null, tags: ['cold'], log: [], contacts: [],
  };
  assert.ok(hu(scheduled).includes('overdue_followup'));
});

test('a warm/active deal with no next step IS still flagged (not down-ranked)', () => {
  const warm = {
    companyKey: 'k', companyName: 'Warm Co', stage: 'contacted', dealValue: 0,
    nextFollowUp: null, lastContact: new Date(NOW_MS - 2 * 86400000).toISOString(),
    tags: ['warm'], log: [{ at: new Date(NOW_MS - 2 * 86400000).toISOString(), kind: 'call' }], contacts: [],
  };
  assert.ok(hu(warm).includes('no_next_step'));
});

test('cold leads do not dominate the feed: real work sorts above them', () => {
  const clients = [];
  // 20 cold never-worked leads (the noise the owner complained about)
  for (let i = 0; i < 20; i++) clients.push({
    companyKey: `cold${i}`, companyName: `Cold ${i}`, stage: 'lead', dealValue: 0,
    nextFollowUp: null, lastContact: null, tags: ['cold'], log: [], contacts: [],
  });
  // one real overdue warm deal
  clients.push({
    companyKey: 'real', companyName: 'Real Deal', stage: 'quoting', dealValue: 3000,
    nextFollowUp: '2026-06-18', lastContact: new Date(NOW_MS - 3 * 86400000).toISOString(),
    tags: ['warm'], log: [{ at: new Date(NOW_MS - 3 * 86400000).toISOString(), kind: 'call' }], contacts: [],
  });
  const { items } = buildHeadsUp(clients, NOW_MS, START_MS);
  assert.ok(items.length > 0);
  assert.equal(items[0].companyKey, 'real'); // the real deal is #1, not buried under cold noise
});

// ── End-to-end CSV → mapped (Notion) sanity ──────────────────────────────────
test('full Notion CSV maps a warm lead with deal value, tags, and ISO follow-up', () => {
  const csv = [
    'Company Name,Contact Person,Contact Email,Contact Phone,Status,Engagement Level,Deal Value,Source,Order Number,Notes,Last Contact Date,Next Follow-up',
    'Acme Co,Jane Doe,jane@acme.com,201-555-1212,Warm (Leads),High,"$2,500",Meta Ad,,promising,2026-06-01,2026-06-25',
  ].join('\n');
  const mappedRows = parseTrackerCsv(csv, { year: 2026 });
  assert.equal(mappedRows.length, 1);
  const m = mappedRows[0];
  assert.equal(m.companyName, 'Acme Co');
  assert.equal(m.stage, 'contacted');         // Warm (Leads)
  assert.ok(m.tags.includes('warm'));
  assert.ok(m.tags.includes('eng-high'));
  assert.equal(m.dealValue, 2500);
  assert.equal(m.leadSource, 'Meta Ad');
  assert.equal(m.nextFollowUp.getUTCDate(), 25);
  assert.equal(m.email, 'jane@acme.com');
  assert.match(m.logs[0].text, /Imported from Notion CRM/);
});

// ── NEW CONTRACT: the importer NEVER yields stage 'customer' ──────────────────
// "customer" is earned only by a VERIFIED placed Order, promoted owner-side by
// the controller — never fabricated by an import from a status word or a
// free-text order-number cell. These guard the whole importer surface.
test('mapStatus never returns "customer" for any status vocabulary', () => {
  const vocab = [
    'Hot (Clients)', 'Orders In Progress', 'Won Orders', 'Warm (Leads)',
    'Room Temp (Opportunities)', 'Cold (Prospects)', 'Lost Orders', 'Meta Ad Conversions',
    'customer', 'client', 'active', 'existing customer', 'active client',
    'hot', 'warm', 'cold', 'opportunity', 'reorder', 'won', 'order placed',
    'quoting', 'sampling', 'visited', 'left vm', 'not interested',
  ];
  for (const s of vocab) {
    assert.notEqual(mapStatus(s), 'customer', `mapStatus(${JSON.stringify(s)}) must not be "customer"`);
  }
});

test('mapTrackerRow never emits stage "customer" — even with an order number/status', () => {
  const rows = [
    { companyName: 'A', status: 'Hot (Clients)' },
    { companyName: 'B', status: 'Orders In Progress' },
    { companyName: 'C', status: 'customer' },
    { companyName: 'D', status: 'active client' },
    { companyName: 'E', status: 'Cold (Prospects)', orderNumber: '21' },     // order HINT
    { companyName: 'F', status: 'Warm (Leads)', orderStatus: 'Paid' },        // order-state HINT
    { companyName: 'G', status: 'Won Orders', orderNumber: '99' },
  ];
  for (const r of rows) {
    const m = mapTrackerRow(r, { format: 'notion' });
    assert.notEqual(m.stage, 'customer', `row ${r.companyName} must not map to customer`);
  }
});

test('the "customer"/"client" status word maps to contacted (not customer)', () => {
  assert.equal(mapStatus('customer'), 'contacted');
  assert.equal(mapStatus('existing client'), 'contacted');
  assert.equal(mapStatus('active'), 'contacted');
});

test('applyImportToDoc never sets customer from a status WORD of "customer"', () => {
  // Even if a mapped row somehow carries stage 'customer' (it shouldn't), a doc
  // with no verified placed order must NOT be promoted by the status-word branch.
  const d = doc({ stage: 'lead' });
  applyImportToDoc(d, mapped({ stage: 'customer' }), false, { hasOrders: false });
  assert.notEqual(d.stage, 'customer');
  assert.equal(d.stage, 'lead'); // untouched — only a real placed order promotes
});

// ── isCustomer is true ONLY with a real PLACED order ─────────────────────────
// Mirrors getOne's rule exactly: isCustomer = orders.some(o => PLACED includes).
const isCustomerFrom = (orders) => orders.some((o) => PLACED_STATUSES.includes(o.status));

test('PLACED_STATUSES is the real-order set (excludes quoted/approved/cancelled)', () => {
  assert.deepEqual(PLACED_STATUSES, ['placed', 'in_production', 'shipped', 'delivered']);
  for (const s of ['quoted', 'approved', 'cancelled']) {
    assert.ok(!PLACED_STATUSES.includes(s), `${s} must NOT be a placed status`);
  }
});

test('isCustomer is FALSE for a company with only quotes/approved/cancelled', () => {
  assert.equal(isCustomerFrom([{ status: 'quoted' }]), false);
  assert.equal(isCustomerFrom([{ status: 'approved' }]), false);
  assert.equal(isCustomerFrom([{ status: 'cancelled' }]), false);
  assert.equal(isCustomerFrom([{ status: 'quoted' }, { status: 'approved' }, { status: 'cancelled' }]), false);
  assert.equal(isCustomerFrom([]), false);
});

test('isCustomer is TRUE as soon as one order is in a placed status', () => {
  for (const s of PLACED_STATUSES) {
    assert.equal(isCustomerFrom([{ status: 'quoted' }, { status: s }]), true, `placed via ${s}`);
  }
  assert.equal(isCustomerFrom([{ status: 'delivered' }]), true);
});

// ── Auto-bump on placement: fires on placed; never regresses won/lost/dormant ─
// The controller helper promotes via promoteStage(stage,'customer'). We verify
// (a) the placed-status gate, and (b) the exact promotion composition it uses.
test('isPlacedStatus gates exactly the placed statuses', () => {
  for (const s of ['placed', 'in_production', 'shipped', 'delivered']) {
    assert.equal(isPlacedStatus(s), true, s);
  }
  for (const s of ['quoted', 'approved', 'cancelled', '', undefined]) {
    assert.equal(isPlacedStatus(s), false, String(s));
  }
});

test('auto-bump promotes a pre-customer stage to customer on placement', () => {
  // The helper does promoteStage(current, 'customer') for each placed order.
  for (const from of ['lead', 'contacted', 'quoting']) {
    assert.equal(promoteStage(from, 'customer'), 'customer', `bump from ${from}`);
  }
});

test('auto-bump on placement NEVER regresses won / lost / dormant', () => {
  assert.equal(promoteStage('won', 'customer'), 'won');         // stays won (not regressed)
  assert.equal(promoteStage('lost', 'customer'), 'lost');       // deliberate end state untouched
  assert.equal(promoteStage('dormant', 'customer'), 'dormant'); // parked deal not resurrected
  // and an already-customer stays customer (idempotent)
  assert.equal(promoteStage('customer', 'customer'), 'customer');
});
