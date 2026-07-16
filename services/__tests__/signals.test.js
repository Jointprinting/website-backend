// services/__tests__/signals.test.js
//
// Unit tests for the pure helpers behind the Signals feed (services/signals.js):
// the order-age thresholds, ET follow-up bucketing, and group assembly.

const test = require('node:test');
const assert = require('node:assert');

const {
  classifyOrderAge,
  bucketFollowUps,
  toGroups,
  AGE_RUNNING_LONG,
  AGE_POSSIBLY_LATE,
} = require('../signals');

test('classifyOrderAge honors the 2-week / 3-week turnaround thresholds', () => {
  assert.strictEqual(classifyOrderAge(null), null);
  assert.strictEqual(classifyOrderAge(0), null);
  assert.strictEqual(classifyOrderAge(AGE_RUNNING_LONG - 1), null);        // 13d
  assert.strictEqual(classifyOrderAge(AGE_RUNNING_LONG), 'running_long');  // 14d
  assert.strictEqual(classifyOrderAge(AGE_POSSIBLY_LATE - 1), 'running_long'); // 20d
  assert.strictEqual(classifyOrderAge(AGE_POSSIBLY_LATE), 'possibly_late'); // 21d
  assert.strictEqual(classifyOrderAge(45), 'possibly_late');
});

test('bucketFollowUps splits overdue vs due-today by ET calendar day and drops closed/empty', () => {
  // now = 11am ET on 2026-07-02 (15:00Z is safely mid-morning Eastern)
  const now = new Date('2026-07-02T15:00:00Z');
  const clients = [
    { companyKey: 'a', stage: 'lead',      nextFollowUp: new Date('2026-06-30T00:00:00Z') }, // -2 → overdue
    { companyKey: 'b', stage: 'contacted', nextFollowUp: new Date('2026-07-01T00:00:00Z') }, // -1 → overdue
    { companyKey: 'c', stage: 'quoting',   nextFollowUp: new Date('2026-07-02T00:00:00Z') }, //  0 → due today
    { companyKey: 'd', stage: 'lead',      nextFollowUp: new Date('2026-07-06T00:00:00Z') }, // +4 → upcoming (neither)
    { companyKey: 'e', stage: 'won',       nextFollowUp: new Date('2026-06-01T00:00:00Z') }, // closed → excluded
    { companyKey: 'f', stage: 'lead',      nextFollowUp: null },                              // no date → excluded
  ];
  const { overdue, dueToday } = bucketFollowUps(clients, now);
  assert.deepStrictEqual(overdue.map((c) => c.companyKey), ['a', 'b']); // most-overdue first (-2 before -1)
  assert.deepStrictEqual(dueToday.map((c) => c.companyKey), ['c']);
});

test('bucketFollowUps orders overdue most-overdue-first', () => {
  const now = new Date('2026-07-02T15:00:00Z');
  const clients = [
    { companyKey: 'recent', stage: 'lead', nextFollowUp: new Date('2026-07-01T00:00:00Z') }, // -1
    { companyKey: 'oldest', stage: 'lead', nextFollowUp: new Date('2026-06-20T00:00:00Z') }, // -12
  ];
  const { overdue } = bucketFollowUps(clients, now);
  assert.deepStrictEqual(overdue.map((c) => c.companyKey), ['oldest', 'recent']);
});

test('toGroups buckets by severity, drops empty groups, and counts the non-empty ones', () => {
  const input = [
    { id: 'a', severity: 'critical', count: 2, items: [] },
    { id: 'b', severity: 'critical', count: 0, items: [] }, // empty → dropped
    { id: 'c', severity: 'warning', count: 1, items: [] },
    { id: 'd', severity: 'info', count: 0, items: [] },     // empty → dropped
    { id: 'e', severity: 'info', count: 3, items: [] },
  ];
  const { groups, counts } = toGroups(input);
  assert.deepStrictEqual(groups.critical.map((g) => g.id), ['a']);
  assert.deepStrictEqual(groups.warning.map((g) => g.id), ['c']);
  assert.deepStrictEqual(groups.info.map((g) => g.id), ['e']);
  assert.deepStrictEqual(counts, { critical: 1, warning: 1, info: 1, total: 3 });
});

test('toGroups on an all-empty day yields nothing (clean-day invariant)', () => {
  const { groups, counts } = toGroups([
    { id: 'a', severity: 'critical', count: 0, items: [] },
    { id: 'b', severity: 'warning', count: 0, items: [] },
  ]);
  assert.deepStrictEqual(groups, { critical: [], warning: [], info: [] });
  assert.strictEqual(counts.total, 0);
});

// ── Outreach hot-lead hub alert ───────────────────────────────────────────────
const { bucketOutreachReplies, replyAgeLabel } = require('../signals');
test('bucketOutreachReplies splits hot buying-signals from other new replies', () => {
  const now = new Date('2026-07-03T18:00:00Z');
  const replies = [
    { status: 'new', category: 'asked_pricing', companyName: 'Green Leaf', receivedAt: new Date(now - 3 * 3600000) },
    { status: 'new', category: 'hot_lead', companyName: 'Highland', receivedAt: new Date(now - 5 * 3600000) },
    { status: 'new', category: 'needs_response', companyName: 'Bud Co', receivedAt: new Date(now - 2 * 3600000) },
    { status: 'new', category: 'unsubscribe', companyName: 'Nope', receivedAt: new Date(now) },       // not actionable → dropped
    { status: 'handled', category: 'hot_lead', companyName: 'Done', receivedAt: new Date(now) },        // not new → dropped
  ];
  const { hot, other } = bucketOutreachReplies(replies, now);
  assert.equal(hot.length, 2);           // asked_pricing + hot_lead
  assert.equal(other.length, 1);         // needs_response
  assert.ok(hot.every((h) => h.name && h.metric));
});

test('replyAgeLabel renders hours then days, blank for future/garbage', () => {
  const now = new Date('2026-07-03T18:00:00Z');
  assert.equal(replyAgeLabel(new Date(now - 3 * 3600000), now), '3h');
  assert.equal(replyAgeLabel(new Date(now - 50 * 3600000), now), '2d');
  assert.equal(replyAgeLabel(new Date(now.getTime() + 3600000), now), ''); // future
  assert.equal(replyAgeLabel('garbage', now), '');
});

// ── Per-brand unhandled-inquiry groups ────────────────────────────────────────
const { bucketInquiries, INQUIRY_STALE_DAYS } = require('../signals');
test('bucketInquiries groups by brand, escalates a stale oldest lead to critical', () => {
  const now = new Date('2026-07-16T18:00:00Z');
  const h = (n) => new Date(now - n * 3600000);
  const subs = [
    { _id: '1', status: 'new', source: 'contact',  companyName: 'Acme',      createdAt: h(3) },
    { _id: '2', status: 'new', source: 'webworks', companyName: 'Plumber',   createdAt: h(INQUIRY_STALE_DAYS * 24 + 5) }, // stale → critical
    { _id: '3', status: 'new', source: 'webworks', companyName: 'Roofer',    createdAt: h(1) },
    { _id: '4', status: 'contacted', source: 'atom', companyName: 'Handled', createdAt: h(90) },  // acted on → dropped
    { _id: '5', status: 'new', source: undefined,  name: 'NoSource',         createdAt: h(2) },   // unknown source → contact
  ];
  const groups = bucketInquiries(subs, now);
  assert.equal(groups.length, 3);                              // one group per brand, always
  const byId = Object.fromEntries(groups.map((g) => [g.id, g]));

  assert.equal(byId.inquiry_contact.count, 2);                 // Acme + NoSource fold to contact
  assert.equal(byId.inquiry_contact.severity, 'warning');      // both fresh
  assert.equal(byId.inquiry_contact.view, 'submissions');

  assert.equal(byId.inquiry_webworks.count, 2);
  assert.equal(byId.inquiry_webworks.severity, 'critical');    // oldest waited > stale threshold
  assert.equal(byId.inquiry_webworks.items[0].name, 'Plumber'); // oldest first
  assert.equal(byId.inquiry_webworks.view, 'jpwinquiries');
  assert.equal(byId.inquiry_webworks.brand, 'JP Webworks');

  assert.equal(byId.inquiry_atom.count, 0);                    // contacted lead doesn't nag
});

test('bucketInquiries empty groups vanish through toGroups (clean day → no rows)', () => {
  const { groups, counts } = toGroups(bucketInquiries([], new Date()));
  assert.deepStrictEqual(groups, { critical: [], warning: [], info: [] });
  assert.strictEqual(counts.total, 0);
});
