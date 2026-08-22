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

test('bucketFollowUps splits overdue vs due-today by ET calendar day; a scheduled follow-up is NEVER hidden by stage', () => {
  // now = 11am ET on 2026-07-02 (15:00Z is safely mid-morning Eastern)
  const now = new Date('2026-07-02T15:00:00Z');
  const clients = [
    { companyKey: 'a', stage: 'lead',      nextFollowUp: new Date('2026-06-30T00:00:00Z') }, // -2 → overdue
    { companyKey: 'b', stage: 'contacted', nextFollowUp: new Date('2026-07-01T00:00:00Z') }, // -1 → overdue
    { companyKey: 'c', stage: 'quoting',   nextFollowUp: new Date('2026-07-02T00:00:00Z') }, //  0 → due today
    { companyKey: 'd', stage: 'lead',      nextFollowUp: new Date('2026-07-06T00:00:00Z') }, // +4 → upcoming (neither)
    // The Happy Leaf case: a WON client with a deliberately-scheduled QA follow-up
    // due today — it MUST surface (the bug was closed stages being dropped here).
    { companyKey: 'qa', stage: 'won',      nextFollowUp: new Date('2026-07-02T00:00:00Z') }, //  0 → due today
    { companyKey: 'e', stage: 'lost',      nextFollowUp: new Date('2026-06-01T00:00:00Z') }, // -31 → overdue (scheduled, shows)
    { companyKey: 'f', stage: 'lead',      nextFollowUp: null },                              // no date → excluded
  ];
  const { overdue, dueToday } = bucketFollowUps(clients, now);
  assert.deepStrictEqual(overdue.map((c) => c.companyKey), ['e', 'a', 'b']); // most-overdue first (-31, -2, -1)
  assert.deepStrictEqual(dueToday.map((c) => c.companyKey), ['c', 'qa']);    // won QA touch shows alongside the lead
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

// ── Quotes awaiting approval / expiring ───────────────────────────────────────
const { bucketQuotesAwaiting, quoteDaysLeft, QUOTE_VALID_DAYS, QUOTE_EXPIRY_WARN_DAYS } = require('../signals');
test('quoteDaysLeft counts whole days from quotePushedAt + QUOTE_VALID_DAYS', () => {
  const now = new Date('2026-07-17T15:00:00Z');
  const pushed = (days) => new Date(now.getTime() - days * 86400000);
  assert.equal(quoteDaysLeft(pushed(0), now), QUOTE_VALID_DAYS);      // just pushed → full window
  assert.equal(quoteDaysLeft(pushed(QUOTE_VALID_DAYS), now), 0);      // exactly at the edge
  assert.equal(quoteDaysLeft(pushed(QUOTE_VALID_DAYS + 3), now), -3); // lapsed 3 days ago
  assert.equal(quoteDaysLeft(null, now), null);
});

const { daysUntil } = require('../signals');
test('daysUntil counts whole days ahead, negative once past', () => {
  const now = new Date('2026-07-17T15:00:00Z');
  const at = (days) => new Date(now.getTime() + days * 86400000);
  assert.equal(daysUntil(at(3), now), 3);
  assert.equal(daysUntil(at(0), now), 0);
  assert.equal(daysUntil(at(-2), now), -2);
  assert.equal(daysUntil(null, now), null);
  assert.equal(daysUntil('not-a-date', now), null);
});

// The whole point of the split: a quote whose LINK is dead is a broken path (the
// client gets a 410), not a job aging. It must land in its own bucket regardless of
// where the softer quote-validity clock sits.
test('bucketQuotesAwaiting splits dead links from merely-expiring quotes', () => {
  const now = new Date('2026-07-17T15:00:00Z');
  const pushed = (days) => new Date(now.getTime() - days * 86400000);
  // Injected link oracle keyed by _id, so this stays a pure unit test.
  const links = {
    fresh:   { live: true,  closesAt: new Date(now.getTime() + 30 * 86400000) },
    soon:    { live: true,  closesAt: new Date(now.getTime() + 30 * 86400000) },
    today:   { live: true,  closesAt: new Date(now.getTime() + 30 * 86400000) },
    lapsed:  { live: true,  closesAt: new Date(now.getTime() + 30 * 86400000) },
    deadold: { live: false, closesAt: new Date(now.getTime() - 11 * 86400000), reason: 'expired' },
    deadnew: { live: false, closesAt: new Date(now.getTime() - 1 * 86400000),  reason: 'expired' },
    nolink:  { live: false, closesAt: null, reason: 'no_token' },
  };
  const orders = [
    { _id: 'fresh',   projectNumber: '10', companyName: 'Fresh Co',  quotePushedAt: pushed(1) },                    // 6d left → runway, excluded
    { _id: 'soon',    projectNumber: '11', companyName: 'Soon Co',   quotePushedAt: pushed(QUOTE_VALID_DAYS - 1) }, // 1d left → expiring
    { _id: 'today',   projectNumber: '12', companyName: 'Edge Co',   quotePushedAt: pushed(QUOTE_VALID_DAYS) },     // 0d → expiring
    { _id: 'lapsed',  projectNumber: '13', companyName: 'Lapsed Co', quotePushedAt: pushed(QUOTE_VALID_DAYS + 4) }, // -4d, link alive → expiring
    { _id: 'deadold', projectNumber: '14', companyName: 'Dead Old',  quotePushedAt: pushed(2) },                    // link dead 11d → dead
    { _id: 'deadnew', projectNumber: '15', companyName: 'Dead New',  quotePushedAt: pushed(2) },                    // link dead 1d → dead
    { _id: 'nolink',  projectNumber: '16', companyName: 'Never Sent', quotePushedAt: pushed(20) },                  // pushed, never shared → excluded
    { _id: 'nopush',  projectNumber: '17', companyName: 'No Push',   quotePushedAt: null },                         // never pushed → excluded
  ];
  const { dead, expiring } = bucketQuotesAwaiting(orders, now, (o) => links[o._id] || {});

  // Dead links lead with the longest-dead first, and say so unambiguously.
  assert.deepStrictEqual(dead.map((i) => i._id), ['deadold', 'deadnew']);
  assert.equal(dead[0].metric, 'expired 11d ago');
  assert.equal(dead[1].metric, 'expired 1d ago');
  assert.ok(dead.every((i) => i.metricLevel === 'danger' && i.linkLive === false));

  // Still-openable links, soonest-to-close first.
  assert.deepStrictEqual(expiring.map((i) => i._id), ['lapsed', 'today', 'soon']); // -4, 0, 1
  // The old feed rendered these as "4d ago" / "today" — which read as the quote's
  // AGE. Each now names the clock it's talking about.
  assert.equal(expiring[0].metric, 'quote lapsed 4d ago');
  assert.equal(expiring[1].metric, 'expires today');
  assert.equal(expiring[2].metric, '1d left');
  assert.equal(expiring[2].metricLevel, 'warn');

  // Runway on both clocks, never shared, or never pushed → all kept off the feed.
  const ids = [...dead, ...expiring].map((i) => i._id);
  assert.equal(ids.includes('fresh'), false);
  assert.equal(ids.includes('nolink'), false);
  assert.equal(ids.includes('nopush'), false);
  assert.ok([...dead, ...expiring].every((i) => i.projectNumber)); // deep-link fields carried
  assert.ok(QUOTE_EXPIRY_WARN_DAYS >= 0);
});

// The drift that motivated all of this: opening the share dialog re-pushes the
// snapshot (resetting quotePushedAt to a full window) without touching the token's
// expiry — so the quote clock can read healthy while the link is about to die. The
// row must be governed by whichever closes FIRST.
test('bucketQuotesAwaiting lets the link clock override a healthy quote clock', () => {
  const now = new Date('2026-07-17T15:00:00Z');
  const orders = [{
    _id: 'drifted', projectNumber: '20', companyName: 'Drifted Co',
    quotePushedAt: new Date(now.getTime() - 1 * 86400000), // 6d left on the soft clock
  }];
  const { dead, expiring } = bucketQuotesAwaiting(orders, now, () => ({
    live: true, closesAt: new Date(now.getTime() + 1 * 86400000), // link dies tomorrow
  }));
  assert.equal(dead.length, 0);
  assert.equal(expiring.length, 1);        // surfaced despite 6d of quote validity left
  assert.equal(expiring[0].metric, '1d left');
  assert.equal(expiring[0].quoteDaysLeft, 6);
  assert.equal(expiring[0].linkDaysLeft, 1);
});

// A legacy link with no recorded expiry is open-ended, so the quote clock stays in
// charge rather than the row inventing a death date.
test('bucketQuotesAwaiting falls back to the quote clock for open-ended links', () => {
  const now = new Date('2026-07-17T15:00:00Z');
  const orders = [{
    _id: 'legacy', projectNumber: '21', companyName: 'Legacy Co',
    quotePushedAt: new Date(now.getTime() - (QUOTE_VALID_DAYS + 2) * 86400000),
  }];
  const { dead, expiring } = bucketQuotesAwaiting(orders, now, () => ({
    live: true, closesAt: null, reason: 'ok',
  }));
  assert.equal(dead.length, 0);
  assert.equal(expiring[0].metric, 'quote lapsed 2d ago');
  assert.equal(expiring[0].linkDaysLeft, null);
});

// End-to-end against the REAL approvalLinkState, so the hub and the public token
// gate can't drift apart in what "dead" means.
test('bucketQuotesAwaiting agrees with the real approvalLinkState', () => {
  const now = new Date('2026-07-17T15:00:00Z');
  const orders = [
    { _id: 'live', projectNumber: '30', companyName: 'Live Co',
      quotePushedAt: new Date(now.getTime() - QUOTE_VALID_DAYS * 86400000),
      approvalToken: 'tok-a', approvalTokenExpiresAt: new Date(now.getTime() + 5 * 86400000) },
    { _id: 'gone', projectNumber: '31', companyName: 'Gone Co',
      quotePushedAt: new Date(now.getTime() - 2 * 86400000),
      approvalToken: 'tok-b', approvalTokenExpiresAt: new Date(now.getTime() - 3 * 86400000) },
  ];
  const { dead, expiring } = bucketQuotesAwaiting(orders, now);
  assert.deepStrictEqual(dead.map((i) => i._id), ['gone']);
  assert.equal(dead[0].metric, 'expired 3d ago');
  assert.deepStrictEqual(expiring.map((i) => i._id), ['live']);
  assert.equal(expiring[0].metric, 'expires today'); // quote lapses today, link fine
});

// ── Webworks client-site edits waiting ────────────────────────────────────────
const { bucketSiteEdits } = require('../signals');
test('bucketSiteEdits totals open (non-done) edits, one item per site with a backlog', () => {
  const sites = [
    { _id: 's1', name: 'Cape May Brewing', companyKey: 'cape-may', edits: [
      { status: 'open' }, { status: 'in_progress' }, { status: 'done' }] },   // 2 open
    { _id: 's2', name: 'Shore Smoke', companyKey: 'shore', edits: [{ status: 'done' }] }, // all done → skipped
    { _id: 's3', companyName: 'Main St Deli', edits: [{ status: 'open' }] },   // 1 open, name from companyName
    { _id: 's4', name: 'No Edits', edits: [] },                                // none → skipped
  ];
  const { total, items } = bucketSiteEdits(sites);
  assert.equal(total, 3);                                    // 2 + 1
  assert.deepStrictEqual(items.map((i) => i._id), ['s1', 's3']);
  assert.equal(items[0].metric, '2×');
  assert.equal(items[1].name, 'Main St Deli');              // falls back to companyName
  assert.deepStrictEqual(bucketSiteEdits([]), { total: 0, items: [] }); // clean day
});

// ---------------------------------------------------------------------------
// BROWSER CRASHES on the hub.
//
// The judgement being pinned: a crash on a CLIENT-facing page is critical and a
// crash in the Studio is a warning. Those are genuinely different situations —
// one is a customer stuck mid-approval with no way to reach you, the other is
// the owner's own tool misbehaving while he is sitting in front of it. Ranking
// them the same buries the one that costs an order.
// ---------------------------------------------------------------------------
const { browserCrashes: _browserCrashes } = require('../signals');
const ClientError = require('../../models/ClientError');

// Stand in for the query chain without a database.
function stubClientErrors(t, rows) {
  t.mock.method(ClientError, 'find', () => ({
    select: () => ({ sort: () => ({ limit: () => ({ lean: async () => rows }) }) }),
  }));
}

test('crashes: a clean week produces no signal at all', async (t) => {
  stubClientErrors(t, []);
  assert.deepEqual(await _browserCrashes(), []);
});

test('crashes: a client-facing crash is CRITICAL', async (t) => {
  stubClientErrors(t, [
    { _id: 'a', route: '/approve/:token', message: 'x is not a function', clientFacing: true, count: 3 },
  ]);
  const [g] = await _browserCrashes();
  assert.equal(g.severity, 'critical');
  assert.match(g.label, /a CLIENT is using/);
  assert.equal(g.count, 1);
});

test('crashes: a Studio-only crash is a warning, not a crisis', async (t) => {
  stubClientErrors(t, [
    { _id: 'b', route: '/studio', message: 'boom', clientFacing: false, count: 1 },
  ]);
  const [g] = await _browserCrashes();
  assert.equal(g.severity, 'warning');
  assert.match(g.label, /in the Studio/);
});

test('crashes: both kinds at once are two separate groups, client first', async (t) => {
  stubClientErrors(t, [
    { _id: 'a', route: '/approve/:token', message: 'boom', clientFacing: true, count: 2 },
    { _id: 'b', route: '/studio', message: 'bang', clientFacing: false, count: 5 },
  ]);
  const gs = await _browserCrashes();
  assert.equal(gs.length, 2);
  assert.equal(gs[0].severity, 'critical');
  assert.equal(gs[1].severity, 'warning');
});

test('crashes: the count is DISTINCT problems, the label carries occurrences', async (t) => {
  // One bug hit forty times is one thing to fix — the badge must not read 40.
  stubClientErrors(t, [
    { _id: 'a', route: '/approve/:token', message: 'boom', clientFacing: true, count: 40 },
  ]);
  const [g] = await _browserCrashes();
  assert.equal(g.count, 1, 'one problem');
  assert.match(g.label, /40 times/);
});

test('crashes: a single occurrence does not say "1 times"', async (t) => {
  stubClientErrors(t, [
    { _id: 'a', route: '/approve/:token', message: 'boom', clientFacing: true, count: 1 },
  ]);
  const [g] = await _browserCrashes();
  assert.ok(!/times/.test(g.label), g.label);
});

test('crashes: items carry the page and the message — that IS the diagnosis', async (t) => {
  stubClientErrors(t, [
    { _id: 'a', route: '/approve/:token', message: 'Cannot read qty of undefined', clientFacing: true, count: 2 },
  ]);
  const [g] = await _browserCrashes();
  assert.equal(g.items[0].name, '/approve/:token — Cannot read qty of undefined');
  assert.equal(g.items[0].metric, '2×');
  assert.equal(g.items[0].metricLevel, 'danger');
});
