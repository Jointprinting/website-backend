// controllers/__tests__/crmReconcile.test.js
//
// PURE-logic checks for the owner-triggered data reconcile (no DB):
//   • csv → cleanDataset: Meta-ad rows skip + queue for archive; cold/lost KEPT;
//     stage mapping (Phase-1 contract); structured leadSource enum; alias collapse
//   • dedup/matchKey: one client per company by exact companyKey; distinct
//     companies NEVER merged; alias rows fold into one card
//   • historical orders minted from order numbers, linked by companyKey
//   • discrepancy detection (implied-order-no-number, collision, unparsable $,
//     ambiguous date, meta-ad-with-order, owner-flagged)
//   • cleanDataset + currentClients → plan (the diff): create vs update vs archive
//     vs orders-to-load; idempotency (re-run = no-op); look-alike proposals
//   • dates stored at UTC NOON
//
//   node --test controllers/__tests__/crmReconcile.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildCleanDataset, detectDiscrepancies, buildReconcilePlan,
  isMetaAdStatus, deriveOrderStatus, deriveOrderPaid, statusImpliesOrder,
  normalizeOrderNumber, furthestStage,
} = require('../../services/crmReconcile');

const {
  mapLeadSource, parseAliasNames, deriveCompanyKey, extractDateInfo,
} = require('../../utils/fieldTrackerImport');

// A Notion-shaped CSV header matching the owner's real export (the junk
// Property / " 1".." 15" / CLIENTS - HOT / Select columns are intentionally
// included to prove they're ignored).
const HEADER = 'Company Name,Property, 1, 2,CLIENTS - HOT,Contact Email,Contact Person,Contact Phone,Deal Value,Engagement Level,Last Contact Date,Next Follow-up,Notes,Order Number,Order Status,Select,Source,Status';

function csv(...rows) {
  return [HEADER, ...rows].join('\n');
}

// ── leadSource enum mapping ──────────────────────────────────────────────────
test('mapLeadSource normalizes raw Source text into the structured enum', () => {
  assert.equal(mapLeadSource('Referral'), 'Referral');
  assert.equal(mapLeadSource('referred by a friend'), 'Referral');
  assert.equal(mapLeadSource('Meta Ad'), 'Social Media');
  assert.equal(mapLeadSource('Instagram DM'), 'Social Media');
  assert.equal(mapLeadSource('trade show booth'), 'Event');
  assert.equal(mapLeadSource('cold call'), 'Cold Outreach');
  assert.equal(mapLeadSource('partner reseller'), 'Partnership');
  assert.equal(mapLeadSource('google search / SEO'), 'Organic Search');
  assert.equal(mapLeadSource('PPC campaign'), 'Advertising');
  assert.equal(mapLeadSource('contact form on website'), 'Website');
});

test('mapLeadSource returns "" (unknown) for blank/unrecognized — never invents an origin', () => {
  assert.equal(mapLeadSource(''), '');
  assert.equal(mapLeadSource('   '), '');
  assert.equal(mapLeadSource(null), '');
  assert.equal(mapLeadSource('qwertyuiop'), '');
});

// ── alias-name collapsing ────────────────────────────────────────────────────
test('parseAliasNames collapses a slash-list to ONE primary + akas', () => {
  const r = parseAliasNames('Happy Leaf / One Green Leaf / The Healing Side');
  assert.equal(r.primary, 'Happy Leaf');
  assert.deepEqual(r.akas, ['One Green Leaf', 'The Healing Side']);
});

test('parseAliasNames handles a parenthetical alias list', () => {
  const r = parseAliasNames('Swan Rose Holdings (Cannabis Connoisseur / Premier High Life / Mush Love)');
  assert.equal(r.primary, 'Swan Rose Holdings');
  assert.deepEqual(r.akas, ['Cannabis Connoisseur', 'Premier High Life', 'Mush Love']);
});

test('parseAliasNames handles an arrow ("X -> Y") and a single name', () => {
  assert.deepEqual(parseAliasNames('Voodoo Brewing Co -> Good Company'), { primary: 'Voodoo Brewing Co', akas: ['Good Company'] });
  assert.deepEqual(parseAliasNames('Acme'), { primary: 'Acme', akas: [] });
  assert.deepEqual(parseAliasNames(''), { primary: '', akas: [] });
});

test('parseAliasNames NEVER splits a numeric fraction/ratio or keys a company on a number', () => {
  // "24/7" is not an alias delimiter — the company keeps its real identity.
  assert.deepEqual(parseAliasNames('24/7 Dispensary'), { primary: '24/7 Dispensary', akas: [] });
  assert.deepEqual(parseAliasNames('9/11 Memorial Shop'), { primary: '9/11 Memorial Shop', akas: [] });
  assert.deepEqual(parseAliasNames('1/2 Off Deals'), { primary: '1/2 Off Deals', akas: [] });
  // The chosen primary is always a plausible name (never a bare number/fragment).
  assert.ok(/[a-z]/i.test(parseAliasNames('24/7 Dispensary').primary));
});

test('parseAliasNames treats a location/branch parenthetical as part of the name, not an aka', () => {
  assert.deepEqual(parseAliasNames('Dunder Mifflin (Scranton Branch)'), { primary: 'Dunder Mifflin', akas: [] });
  assert.deepEqual(parseAliasNames('Acme (Store #3)'), { primary: 'Acme', akas: [] });
});

// ── csv → cleanDataset: meta-ad skip + keep cold/lost ────────────────────────
test('buildCleanDataset SKIPS Meta-ad rows (queues them for archive) and KEEPS the real clients', () => {
  const ds = buildCleanDataset(csv(
    'Real Co,,,,,a@x.com,Jane,,$1000,High,"June 19, 2025","June 23, 2025",note,,,,,Warm (Leads)',
    'Junk One,,,,,,,,,,"June 19, 2025","June 23, 2025",,,,,,Meta Ad Conversions',
    'Junk Two,,,,,,,,,,,,,,,,,Meta Ad Conversions',
  ));
  assert.equal(ds.clients.length, 1, 'only the real client is loaded');
  assert.equal(ds.clients[0].companyName, 'Real Co');
  assert.equal(ds.junk.length, 2, 'both Meta-ad rows are queued for archive');
  assert.ok(ds.junk.every((j) => /meta/i.test(j.status)));
});

test('buildCleanDataset KEEPS cold prospects and lost orders (real records the owner re-contacts)', () => {
  const ds = buildCleanDataset(csv(
    'Cold Co,,,,,,Bob,,,,,,,,,,,Cold (Prospects)',
    'Lost Co,,,,,,Sue,,,,,,,,,,,Lost Orders',
  ));
  const byKey = Object.fromEntries(ds.clients.map((c) => [c.companyKey, c]));
  assert.equal(ds.clients.length, 2);
  assert.equal(byKey.coldco.stage, 'lead');
  assert.ok(byKey.coldco.tags.includes('cold'));
  assert.equal(byKey.lostco.stage, 'dormant');
  assert.ok(byKey.lostco.tags.includes('lost'));
});

// ── stage mapping: the Phase-1 contract (NEVER 'customer' from a word) ───────
test('buildCleanDataset maps each Notion Status to the Phase-1 stage + tag, never customer', () => {
  const cases = [
    ['Hot (Clients)',             'contacted', 'hot'],
    ['Warm (Leads)',              'contacted', 'warm'],
    ['Room Temp (Opportunities)', 'contacted', 'room-temp'],
    ['Cold (Prospects)',          'lead',      'cold'],
    ['Lost Orders',               'dormant',   'lost'],
    ['Orders In Progress',        'quoting',   'in-progress'],
    ['Won Orders',                'won',       'won'],
  ];
  for (const [status, stage, tag] of cases) {
    const ds = buildCleanDataset(csv(`Co ${tag},,,,,,P,,,,,,,,,,,${status}`));
    assert.equal(ds.clients.length, 1, `loaded for ${status}`);
    assert.equal(ds.clients[0].stage, stage, `stage for ${status}`);
    assert.ok(ds.clients[0].tags.includes(tag), `tag ${tag} for ${status}`);
    assert.notEqual(ds.clients[0].stage, 'customer');
  }
});

// ── carried fields + dates at UTC noon ───────────────────────────────────────
test('buildCleanDataset carries contact/deal/notes and stores dates at UTC NOON', () => {
  const ds = buildCleanDataset(csv(
    'Carry Co,,,,,c@x.com,Carl,719-555-1212,"$8,000.00",High,"February 23, 2026","June 26, 2026",hello,,,,,Hot (Clients)',
  ));
  const c = ds.clients[0];
  assert.equal(c.email, 'c@x.com');
  assert.equal(c.phone, '719-555-1212'); // original formatting preserved (matching the importer)
  assert.equal(c.dealValue, 8000);
  assert.equal(c.notes, 'hello');
  // UTC noon convention: both dates land at exactly 12:00:00Z on their calendar day.
  assert.equal(c.lastContact.toISOString(), '2026-02-23T12:00:00.000Z');
  assert.equal(c.nextFollowUp.toISOString(), '2026-06-26T12:00:00.000Z');
});

test('extractDateInfo parses long-form "Month DD, YYYY" at UTC noon (the owner\'s Notion shape)', () => {
  assert.equal(extractDateInfo('June 19, 2025').date.toISOString(), '2025-06-19T12:00:00.000Z');
  assert.equal(extractDateInfo('Feb 23 2026').date.toISOString(), '2026-02-23T12:00:00.000Z');
  assert.equal(extractDateInfo('September 8, 2025').date.toISOString(), '2025-09-08T12:00:00.000Z');
  // Still parses ISO + M/D as before.
  assert.equal(extractDateInfo('2026-06-24').date.toISOString(), '2026-06-24T12:00:00.000Z');
  assert.equal(extractDateInfo('6/9', 2026).date.toISOString(), '2026-06-09T12:00:00.000Z');
});

// ── historical orders ────────────────────────────────────────────────────────
test('buildCleanDataset mints a historical Order for each non-empty Order Number, linked by companyKey', () => {
  const ds = buildCleanDataset(csv(
    'Won Co,,,,,,P,,$5000,,,,,114,Completed,,,Won Orders',
    'NoOrder Co,,,,,,P,,,,,,,,,,,Warm (Leads)',
  ));
  assert.equal(ds.orders.length, 1, 'only the row with an order number mints an order');
  const o = ds.orders[0];
  assert.equal(o.orderNumber, '114');
  assert.equal(o.companyKey, deriveCompanyKey('Won Co', ''));
  assert.equal(o.status, 'delivered');     // "Completed" → delivered
  assert.equal(o.paid, true);
  assert.equal(o.importedFrom, 'notion');
  assert.equal(o.totalValue, 5000);
});

test('deriveOrderStatus / deriveOrderPaid map Notion order-status text conservatively', () => {
  assert.equal(deriveOrderStatus('Completed'), 'delivered');
  assert.equal(deriveOrderStatus('Paid'), 'delivered');
  assert.equal(deriveOrderStatus('In Transit'), 'shipped');
  assert.equal(deriveOrderStatus('Mockups in Progress'), 'approved');
  assert.equal(deriveOrderStatus('Quoting'), 'quoted');
  assert.equal(deriveOrderStatus('', 'Cancelled order'), 'cancelled');
  assert.equal(deriveOrderStatus(''), 'quoted');
  assert.equal(deriveOrderPaid('Completed'), true);
  assert.equal(deriveOrderPaid('Quoting'), false);
});

// ── dedup: one client per company; distinct companies never merged ───────────
test('two rows that collapse to the same companyKey fold into ONE client (no dupe card)', () => {
  const ds = buildCleanDataset(csv(
    'Acme / Acme Brand,,,,,a@acme.com,Jane,,$1000,,,,,,,,,Warm (Leads)',
    'Acme,,,,,,Bob,719-555-0000,,,,,second note,,,,,Hot (Clients)',
  ));
  const acme = ds.clients.filter((c) => c.companyKey === 'acme');
  assert.equal(acme.length, 1, 'exactly one Acme client');
  // Fold keeps the furthest-along stage and fills blanks.
  assert.equal(acme[0].stage, 'contacted');
  assert.equal(acme[0].email, 'a@acme.com');
});

test('dedup NEVER merges two genuinely-distinct companies (different companyKey survive as two)', () => {
  const ds = buildCleanDataset(csv(
    'Bleu Leaf,,,,,,P,,,,,,,,,,,Warm (Leads)',
    'Bleu Leaf Dispensary,,,,,,P,,,,,,,,,,,Warm (Leads)',
  ));
  const keys = new Set(ds.clients.map((c) => c.companyKey));
  assert.equal(ds.clients.length, 2, 'distinct companies stay distinct');
  assert.ok(keys.has('bleuleaf'));
  assert.ok(keys.has('bleuleafdispensary'));
});

test('furthestStage never drags a record out of (or into) lost/dormant', () => {
  assert.equal(furthestStage('dormant', 'won'), 'dormant');
  assert.equal(furthestStage('lost', 'contacted'), 'lost');
  assert.equal(furthestStage('contacted', 'dormant'), 'contacted');
  assert.equal(furthestStage('lead', 'quoting'), 'quoting');
  assert.equal(furthestStage('won', 'lead'), 'won');
});

// ── discrepancy detection ────────────────────────────────────────────────────
test('discrepancy: a Status/Order-Status that implies an order but has NO order number is flagged', () => {
  const ds = buildCleanDataset(csv(
    'InFlight Co,,,,,,P,,,,,,,,In Transit,,,Orders In Progress',
  ));
  const d = ds.discrepancies.find((x) => x.kind === 'order-implied-no-number');
  assert.ok(d, 'implied-order discrepancy present');
  assert.equal(d.company, 'InFlight Co');
});

test('discrepancy: an order number used by >1 company is flagged as a collision', () => {
  const ds = buildCleanDataset(csv(
    'Alpha,,,,,,P,,,,,,,100,Completed,,,Won Orders',
    'Beta,,,,,,P,,,,,,,#100,Completed,,,Won Orders',
  ));
  const d = ds.discrepancies.find((x) => x.kind === 'order-number-collision');
  assert.ok(d, 'collision discrepancy present');
  assert.equal(d.orderNumber, '100');
});

test('discrepancy: a Deal Value that does not parse is flagged (and left at 0)', () => {
  const ds = buildCleanDataset(csv(
    'BadVal Co,,,,,,P,,"ask Jim",,,,,,,,,Warm (Leads)',
  ));
  const d = ds.discrepancies.find((x) => x.kind === 'deal-value-unparsable');
  assert.ok(d, 'unparsable deal value discrepancy present');
  assert.equal(ds.clients[0].dealValue, 0);
});

test('discrepancy: a Meta-ad junk row that carries an order number is surfaced before archiving', () => {
  const ds = buildCleanDataset(csv(
    'Junky,,,,,,P,,,,,,,92,,,,Meta Ad Conversions',
  ));
  const d = ds.discrepancies.find((x) => x.kind === 'meta-ad-with-order');
  assert.ok(d, 'meta-ad-with-order discrepancy present');
  assert.equal(d.orderNumber, '92');
});

test('discrepancy: a curated owner-flagged note is merged in (Happy-Leaf-style)', () => {
  const ds = buildCleanDataset(
    csv('Happy Leaf,,,,,,P,,,,,,,,,,,Room Temp (Opportunities)'),
    { knownDiscrepancies: [{ companyKey: 'happyleaf', kind: 'order-implied-no-number', severity: 'warn', detail: 'has a completed order' }] },
  );
  const d = ds.discrepancies.find((x) => x.ownerFlagged);
  assert.ok(d, 'owner-flagged discrepancy present');
  assert.equal(d.company, 'Happy Leaf');
});

test('a stale owner-flagged note for a company NOT in the dataset is dropped', () => {
  const ds = buildCleanDataset(
    csv('Real Co,,,,,,P,,,,,,,,,,,Warm (Leads)'),
    { knownDiscrepancies: [{ companyKey: 'ghostcompany', detail: 'x' }] },
  );
  assert.equal(ds.discrepancies.filter((x) => x.ownerFlagged).length, 0);
});

// ── plan: the diff against current DB state ──────────────────────────────────
function dataset2() {
  return buildCleanDataset(csv(
    'New Co,,,,,n@x.com,P,,$2000,,,,,114,Completed,,,Won Orders',
    'Existing Co,,,,,e@x.com,P,,,,,,,,,,,Warm (Leads)',
    'Junk Co,,,,,,,,,,,,,,,,,Meta Ad Conversions',
  ));
}

test('buildReconcilePlan: a brand-new company is created; an existing one (by companyKey) is updated, never duplicated', () => {
  const ds = dataset2();
  const plan = buildReconcilePlan(ds, {
    clients: [{ companyKey: 'existingco', companyName: 'Existing Co', source: 'manual', stage: 'contacted', archived: false }],
    orders: [],
  });
  assert.equal(plan.clientsToCreate.length, 1);
  assert.equal(plan.clientsToCreate[0].companyKey, 'newco');
  assert.equal(plan.clientsToUpdate.length, 1);
  assert.equal(plan.clientsToUpdate[0].companyKey, 'existingco');
});

test('buildReconcilePlan: the Meta-ad junk is queued for archive (present vs absent tracked)', () => {
  const ds = dataset2();
  const plan = buildReconcilePlan(ds, {
    clients: [{ companyKey: 'junkco', companyName: 'Junk Co', source: 'notion', archived: false }],
    orders: [],
  });
  assert.equal(plan.metaAdJunkToArchive.length, 1);
  assert.equal(plan.metaAdJunkToArchive[0].companyKey, 'junkco');
  assert.equal(plan.metaAdJunkToArchive[0].present, true);
  assert.equal(plan.metaAdJunkToArchive[0].alreadyArchived, false);
});

test('buildReconcilePlan: orders load when absent; an order already present (companyKey + normalized #) is a no-op', () => {
  const ds = dataset2();
  // Run 1: empty DB → order loads.
  const plan1 = buildReconcilePlan(ds, { clients: [], orders: [] });
  assert.equal(plan1.ordersToLoad.length, 1);
  assert.equal(plan1.ordersAlreadyPresent.length, 0);
  // Run 2: the order now exists (stored as "#0114" — normalizes to 114) → no-op.
  const plan2 = buildReconcilePlan(ds, {
    clients: [],
    orders: [{ companyKey: 'newco', orderNumber: '#0114', importedFrom: 'notion' }],
  });
  assert.equal(plan2.ordersToLoad.length, 0);
  assert.equal(plan2.ordersAlreadyPresent.length, 1);
});

test('order dedup matches by normalized number AND scopes to the same company', () => {
  const ds = buildCleanDataset(csv('Co A,,,,,,P,,,,,,,114,Completed,,,Won Orders'));
  // Same number "114" but a DIFFERENT company → still loads (not the same order).
  const plan = buildReconcilePlan(ds, {
    clients: [],
    orders: [{ companyKey: 'someoneelse', orderNumber: '114' }],
  });
  assert.equal(plan.ordersToLoad.length, 1, 'a same-number order under a different company is not a dup');
});

test('buildReconcilePlan is IDEMPOTENT: a second run after everything is applied is a no-op', () => {
  const ds = dataset2();
  // Simulate post-apply state: real clients exist, junk archived, order present.
  const current = {
    clients: [
      { companyKey: 'newco', companyName: 'New Co', source: 'notion', stage: 'won', archived: false },
      { companyKey: 'existingco', companyName: 'Existing Co', source: 'notion', stage: 'contacted', archived: false },
      { companyKey: 'junkco', companyName: 'Junk Co', source: 'notion', archived: true },
    ],
    orders: [{ companyKey: 'newco', orderNumber: '114', importedFrom: 'notion' }],
  };
  const plan = buildReconcilePlan(ds, current, { sweepBadImport: true });
  assert.equal(plan.clientsToCreate.length, 0, 'nothing new to create');
  assert.equal(plan.ordersToLoad.length, 0, 'no orders to load');
  assert.equal(plan.metaAdJunkToArchive.filter((x) => x.present && !x.alreadyArchived).length, 0, 'junk already archived');
  assert.equal(plan.summary.noOp, true);
});

test('buildReconcilePlan: a distinct existing company sharing a fuzzy matchKey is PROPOSED, not auto-merged', () => {
  const ds = buildCleanDataset(csv('Acme,,,,,,P,,,,,,,,,,,Warm (Leads)'));
  const plan = buildReconcilePlan(ds, {
    clients: [{ companyKey: 'acmellc', companyName: 'Acme LLC', matchKey: 'acme', source: 'manual', archived: false }],
    orders: [],
  });
  // We still CREATE acme (distinct identity) and PROPOSE the look-alike.
  assert.equal(plan.clientsToCreate.length, 1);
  assert.equal(plan.clientsToCreate[0].companyKey, 'acme');
  assert.equal(plan.proposedMerges.length, 1);
  assert.equal(plan.proposedMerges[0].existing[0].companyKey, 'acmellc');
});

test('buildReconcilePlan: the bad-import sweep only touches TODAY\'s pure-import strays with no orders', () => {
  const ds = buildCleanDataset(csv('Keeper,,,,,,P,,,,,,,,,,,Warm (Leads)'));
  const today = new Date();
  const yesterday = new Date(Date.now() - 36 * 3600 * 1000);
  const plan = buildReconcilePlan(ds, {
    clients: [
      { companyKey: 'straytoday', companyName: 'Stray Today', source: 'notion', archived: false, createdAt: today },
      { companyKey: 'oldimport', companyName: 'Old Import', source: 'notion', archived: false, createdAt: yesterday },
      { companyKey: 'ownerco', companyName: 'Owner Co', source: 'manual', archived: false, createdAt: today },
      { companyKey: 'hasorder', companyName: 'Has Order', source: 'notion', archived: false, createdAt: today },
    ],
    orders: [{ companyKey: 'hasorder', orderNumber: '5' }],
  }, { sweepBadImport: true, todayStart: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) });
  const swept = new Set(plan.otherBadImportToArchive.map((x) => x.companyKey));
  assert.ok(swept.has('straytoday'), 'today\'s stray import is swept');
  assert.ok(!swept.has('oldimport'), 'an older import is kept');
  assert.ok(!swept.has('ownerco'), 'an owner-origin record is never swept');
  assert.ok(!swept.has('hasorder'), 'a record with order history is kept');
});

test('buildReconcilePlan: the plan the preview would return is exactly what apply consumes (same object)', () => {
  // The controller calls buildReconcilePlan ONCE per request and both the preview
  // projection and the apply execution read the SAME plan — so preview == reality.
  // Here we assert the plan is a pure function of (dataset,current): same inputs →
  // identical create/archive/order sets.
  const ds = dataset2();
  const current = { clients: [], orders: [] };
  const a = buildReconcilePlan(ds, current, { sweepBadImport: true });
  const b = buildReconcilePlan(ds, current, { sweepBadImport: true });
  assert.deepEqual(a.clientsToCreate.map((c) => c.companyKey), b.clientsToCreate.map((c) => c.companyKey));
  assert.deepEqual(a.metaAdJunkToArchive, b.metaAdJunkToArchive);
  assert.deepEqual(a.ordersToLoad.map((o) => o.orderNumber), b.ordersToLoad.map((o) => o.orderNumber));
  assert.deepEqual(a.summary, b.summary);
});

// ── helpers ──────────────────────────────────────────────────────────────────
test('isMetaAdStatus matches the junk status case/space-insensitively', () => {
  assert.equal(isMetaAdStatus('Meta Ad Conversions'), true);
  assert.equal(isMetaAdStatus('meta ad'), true);
  assert.equal(isMetaAdStatus('Warm (Leads)'), false);
  assert.equal(isMetaAdStatus(''), false);
});

test('normalizeOrderNumber matches the finance convention (digits only, no leading zeros)', () => {
  assert.equal(normalizeOrderNumber('#0000021'), '21');
  assert.equal(normalizeOrderNumber('0000021'), '21');
  assert.equal(normalizeOrderNumber('PO-021'), '21');
  assert.equal(normalizeOrderNumber('0000000'), '');
  assert.equal(normalizeOrderNumber(null), '');
});

test('statusImpliesOrder catches won/in-progress statuses and order-state text', () => {
  assert.equal(statusImpliesOrder('Won Orders', ''), true);
  assert.equal(statusImpliesOrder('Orders In Progress', ''), true);
  assert.equal(statusImpliesOrder('Warm (Leads)', 'Completed'), true);
  assert.equal(statusImpliesOrder('Warm (Leads)', ''), false);
  assert.equal(statusImpliesOrder('Cold (Prospects)', 'Lead'), false);
});
