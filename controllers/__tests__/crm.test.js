// controllers/__tests__/crm.test.js
//
// Pure-logic checks for the CRM pipeline math (no DB). Runs on Node's built-in
// test runner — no extra dev deps:
//
//   node --test controllers/__tests__/crm.test.js
//
// summarizePipeline / stageProbability are exported from controllers/crm.js and
// take plain { stage, dealValue } POJOs, so they're testable without Mongo.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizePipeline,
  stageProbability,
  STAGE_PROBABILITY,
  classifyHeadsUp,
  buildHeadsUp,
  HEADS_UP,
} = require('../crm');

// ── Heads-up test scaffolding ────────────────────────────────────────────────
// Fixed clock so day-math is deterministic. NOW = 2026-06-23T18:00Z; START =
// 2026-06-23T00:00Z. Helpers build epoch-ms offsets in days from those anchors.
const NOW_MS   = new Date('2026-06-23T18:00:00Z').getTime();
const START_MS = new Date('2026-06-23T00:00:00Z').getTime();
const daysAgo  = (n) => new Date(NOW_MS - n * 86400000).toISOString();
const daysAhead = (n) => new Date(START_MS + n * 86400000).toISOString();
// A minimal client POJO with sane defaults; override per case.
const mkClient = (over = {}) => ({
  companyKey: 'acme', companyName: 'Acme', phone: '555', dealValue: 0,
  stage: 'quoting', nextFollowUp: null, lastContact: daysAgo(1),
  log: [{ at: daysAgo(1), text: 'touch', kind: 'call' }],
  updatedAt: daysAgo(1), area: '', interestType: '', contacts: [], ...over,
});
const typesFor = (c) => classifyHeadsUp(c, NOW_MS, START_MS).map((i) => i.type).sort();

// ── Probability map ──────────────────────────────────────────────────────────
test('STAGE_PROBABILITY uses the agreed close-rates', () => {
  assert.equal(STAGE_PROBABILITY.lead,      0.1);
  assert.equal(STAGE_PROBABILITY.contacted, 0.25);
  assert.equal(STAGE_PROBABILITY.quoting,   0.5);
  // 'sampling' is retired — it must NOT carry a probability anymore.
  assert.equal(STAGE_PROBABILITY.sampling,  undefined);
  assert.equal(STAGE_PROBABILITY.won,       1);
  assert.equal(STAGE_PROBABILITY.customer,  1);
  assert.equal(STAGE_PROBABILITY.lost,      0);
  assert.equal(STAGE_PROBABILITY.dormant,   0);
});

test('stageProbability falls back to 0 for unknown stages', () => {
  assert.equal(stageProbability('lead'),     0.1);
  assert.equal(stageProbability('nonsense'), 0);
  assert.equal(stageProbability(undefined),  0);
  assert.equal(stageProbability(''),         0);
});

// ── summarizePipeline ────────────────────────────────────────────────────────
test('empty / missing input yields zeroes', () => {
  assert.deepEqual(summarizePipeline([]),        { totalOpenValue: 0, weightedValue: 0, weightedOpenValue: 0 });
  assert.deepEqual(summarizePipeline(undefined), { totalOpenValue: 0, weightedValue: 0, weightedOpenValue: 0 });
  assert.deepEqual(summarizePipeline(null),      { totalOpenValue: 0, weightedValue: 0, weightedOpenValue: 0 });
});

test('totalOpenValue counts only open stages; weightedValue weights every stage', () => {
  const records = [
    { stage: 'lead',      dealValue: 1000 },  // open · weight 0.1  → 100
    { stage: 'contacted', dealValue: 2000 },  // open · weight 0.25 → 500
    { stage: 'quoting',   dealValue: 4000 },  // open · weight 0.5  → 2000
    { stage: 'won',       dealValue: 5000 },  // CLOSED · weight 1   → 5000
    { stage: 'customer',  dealValue: 3000 },  // CLOSED · weight 1   → 3000
    { stage: 'lost',      dealValue: 9999 },  // CLOSED · weight 0   → 0
    { stage: 'dormant',   dealValue: 8888 },  // CLOSED · weight 0   → 0
  ];

  // Open = lead + contacted + quoting (won/customer/lost/dormant excluded)
  const expectedOpen = 1000 + 2000 + 4000; // 7000
  // Weighted = 100 + 500 + 2000 + 5000 + 3000 + 0 + 0
  const expectedWeighted = 100 + 500 + 2000 + 5000 + 3000; // 10600
  // weightedOpen = the OPEN stages' expected value only: 100 + 500 + 2000 = 2600.
  // This is the correct "% likely to land" numerator — always ≤ totalOpenValue.
  const expectedWeightedOpen = 100 + 500 + 2000; // 2600

  const out = summarizePipeline(records);
  assert.equal(out.totalOpenValue, expectedOpen);
  assert.equal(out.weightedValue,  expectedWeighted);
  assert.equal(out.weightedOpenValue, expectedWeightedOpen);
  // The bug guard: weightedOpen / open is a sane rate ≤ 100% (2600/7000 ≈ 37%),
  // unlike the old weightedValue / open (10600/7000 = 151%+).
  assert.ok(out.weightedOpenValue <= out.totalOpenValue, 'weighted-open never exceeds open');
});

test('non-numeric / missing dealValue is treated as 0', () => {
  const records = [
    { stage: 'quoting', dealValue: '2000' },   // numeric string → 1000 weighted
    { stage: 'quoting' },                       // missing → 0
    { stage: 'quoting', dealValue: null },      // null → 0
    { stage: 'quoting', dealValue: undefined }, // undefined → 0
  ];
  const out = summarizePipeline(records);
  assert.equal(out.totalOpenValue, 2000);  // only the '2000' record counts
  assert.equal(out.weightedValue,  1000);  // 2000 × 0.5
});

test('fractional weighting rounds to cents (no float drift)', () => {
  // 333.33 at quoting (0.5) = 166.665 → rounds to 166.67 (round-half-up on .665)
  const out = summarizePipeline([{ stage: 'quoting', dealValue: 333.33 }]);
  assert.equal(out.totalOpenValue, 333.33);
  assert.equal(out.weightedValue,  166.67);
});

// ── classifyHeadsUp ──────────────────────────────────────────────────────────
test('overdue_followup fires on an active deal past its follow-up date', () => {
  // Fresh activity so it ONLY earns the overdue flag (no stale/quiet noise).
  const c = mkClient({ nextFollowUp: daysAhead(-3), dealValue: 500 });
  const items = classifyHeadsUp(c, NOW_MS, START_MS);
  const overdue = items.find((i) => i.type === 'overdue_followup');
  assert.ok(overdue, 'expected an overdue_followup item');
  assert.equal(overdue.severity, 'med');          // below HIGH_VALUE
  assert.match(overdue.message, /3 days overdue/);
});

test('overdue_followup escalates to high severity on a big deal', () => {
  const c = mkClient({ nextFollowUp: daysAhead(-1), dealValue: HEADS_UP.HIGH_VALUE });
  const overdue = classifyHeadsUp(c, NOW_MS, START_MS).find((i) => i.type === 'overdue_followup');
  assert.equal(overdue.severity, 'high');
  assert.match(overdue.message, /1 day overdue/);  // singular day
});

test('overdue_followup does NOT fire for a closed stage', () => {
  const c = mkClient({ stage: 'won', nextFollowUp: daysAhead(-5), dealValue: 9000 });
  assert.ok(!typesFor(c).includes('overdue_followup'));
});

test('no_next_step fires when an active deal has no nextFollowUp', () => {
  const c = mkClient({ nextFollowUp: null, dealValue: 100 });
  const item = classifyHeadsUp(c, NOW_MS, START_MS).find((i) => i.type === 'no_next_step');
  assert.ok(item);
  assert.equal(item.severity, 'low');             // small deal → low
  // A future follow-up suppresses it.
  const scheduled = mkClient({ nextFollowUp: daysAhead(2) });
  assert.ok(!typesFor(scheduled).includes('no_next_step'));
});

test('stale fires when last activity exceeds STALE_DAYS', () => {
  const old = daysAgo(HEADS_UP.STALE_DAYS + 5);
  const c = mkClient({ nextFollowUp: daysAhead(3), lastContact: old, updatedAt: old, log: [{ at: old, text: 'old', kind: 'note' }] });
  const item = classifyHeadsUp(c, NOW_MS, START_MS).find((i) => i.type === 'stale');
  assert.ok(item, 'expected stale');
  assert.match(item.message, new RegExp(`No activity in ${HEADS_UP.STALE_DAYS + 5} days`));
  // Recent updatedAt (e.g. a stage change today) clears staleness even if logs are old.
  const touched = mkClient({ nextFollowUp: daysAhead(3), lastContact: old, updatedAt: daysAgo(1), log: [{ at: old, text: 'old', kind: 'note' }] });
  assert.ok(!typesFor(touched).includes('stale'));
});

test('hot_quiet fires on a top-tier deal gone quiet (and is high severity)', () => {
  const c = mkClient({ dealValue: HEADS_UP.HOT_VALUE, lastContact: daysAgo(HEADS_UP.QUIET_DAYS + 1), nextFollowUp: daysAhead(2), updatedAt: daysAgo(1) });
  const item = classifyHeadsUp(c, NOW_MS, START_MS).find((i) => i.type === 'hot_quiet');
  assert.ok(item, 'expected hot_quiet');
  assert.equal(item.severity, 'high');
  // Recently-contacted hot deal does NOT fire.
  const fresh = mkClient({ dealValue: HEADS_UP.HOT_VALUE, lastContact: daysAgo(2), nextFollowUp: daysAhead(2) });
  assert.ok(!typesFor(fresh).includes('hot_quiet'));
});

test('hot_quiet fires when a hot deal was never contacted', () => {
  const c = mkClient({ dealValue: HEADS_UP.HOT_VALUE + 1000, lastContact: null, nextFollowUp: daysAhead(2), updatedAt: daysAgo(1), log: [{ at: daysAgo(1), text: 'x', kind: 'note' }] });
  const item = classifyHeadsUp(c, NOW_MS, START_MS).find((i) => i.type === 'hot_quiet');
  assert.ok(item);
  assert.match(item.message, /never contacted/);
});

test('a healthy active deal earns no heads-up items', () => {
  const c = mkClient({ dealValue: 500, nextFollowUp: daysAhead(2), lastContact: daysAgo(1), updatedAt: daysAgo(1) });
  assert.deepEqual(typesFor(c), []);
});

test('classifyHeadsUp tolerates null / empty input', () => {
  assert.deepEqual(classifyHeadsUp(null, NOW_MS, START_MS), []);
  assert.deepEqual(classifyHeadsUp(undefined, NOW_MS, START_MS), []);
});

// ── buildHeadsUp (sort + cap + counts) ───────────────────────────────────────
test('buildHeadsUp sorts high severity first, then by deal value', () => {
  const clients = [
    mkClient({ companyKey: 'small-overdue', dealValue: 100,  nextFollowUp: daysAhead(-2) }),        // med
    mkClient({ companyKey: 'hot',           dealValue: 5000, lastContact: daysAgo(40), nextFollowUp: daysAhead(2), updatedAt: daysAgo(1) }), // high
    mkClient({ companyKey: 'big-overdue',   dealValue: 8000, nextFollowUp: daysAhead(-1) }),        // high (big overdue)
  ];
  const { items } = buildHeadsUp(clients, NOW_MS, START_MS);
  // Both 'high' items lead; within high, the $8000 sorts above the $5000.
  assert.equal(items[0].severity, 'high');
  assert.equal(items[0].value, 8000);
  assert.equal(items[1].severity, 'high');
  assert.equal(items[1].value, 5000);
  // The med item lands last.
  assert.equal(items[items.length - 1].severity, 'med');
});

test('buildHeadsUp caps surfaced items but counts the full set', () => {
  // Make many more no_next_step items than the cap.
  const n = HEADS_UP.MAX_ITEMS + 10;
  const clients = Array.from({ length: n }, (_, k) =>
    mkClient({ companyKey: `c${k}`, nextFollowUp: null, dealValue: 100 }));
  const { items, counts, total } = buildHeadsUp(clients, NOW_MS, START_MS);
  assert.equal(items.length, HEADS_UP.MAX_ITEMS);   // surfaced list is capped
  assert.equal(counts.no_next_step, n);             // counts reflect everything
  assert.equal(total, n);
});

test('buildHeadsUp tallies a mix of types', () => {
  const clients = [
    mkClient({ companyKey: 'a', nextFollowUp: daysAhead(-2), dealValue: 300 }),                 // overdue
    mkClient({ companyKey: 'b', nextFollowUp: null, dealValue: 300 }),                          // no_next_step
    mkClient({ companyKey: 'c', dealValue: 5000, lastContact: daysAgo(30), nextFollowUp: daysAhead(2), updatedAt: daysAgo(1) }), // hot_quiet
  ];
  const { counts } = buildHeadsUp(clients, NOW_MS, START_MS);
  assert.equal(counts.overdue_followup, 1);
  assert.equal(counts.no_next_step, 1);
  assert.equal(counts.hot_quiet, 1);
});

// ── Eastern day boundary — the timezone fix ──────────────────────────────────
// classifyHeadsUp judges the WHOLE-DAY nextFollowUp "overdue" by ET calendar day,
// not the UTC server clock. Pin the evening case: it's 2026-06-24 in UTC but still
// 2026-06-23 in Eastern, so the owner's "today" is the 23rd.
const ET_EVENING_NOW = new Date('2026-06-24T01:00:00Z').getTime(); // 6/23 21:00 EDT
// A whole-day follow-up is stored at UTC midnight (its day == its UTC day).
const followUpDay = (ymd) => new Date(`${ymd}T00:00:00Z`).toISOString();
// startToday arg is unused for the day comparison now, but pass a sane ET value.
const ET_START = new Date('2026-06-23T04:00:00Z').getTime();
const overdueTypes = (c) => classifyHeadsUp(c, ET_EVENING_NOW, ET_START)
  .map((i) => i.type);

test('a 6/24 follow-up is NOT overdue on the evening of 6/23 ET (was 6/24 UTC)', () => {
  // Fresh activity so only the follow-up timing could flag it.
  const c = mkClient({
    nextFollowUp: followUpDay('2026-06-24'), dealValue: 500,
    lastContact: followUpDay('2026-06-23'), updatedAt: followUpDay('2026-06-23'),
    log: [{ at: followUpDay('2026-06-23'), text: 'touch', kind: 'call' }],
  });
  assert.ok(!overdueTypes(c).includes('overdue_followup'),
    'a tomorrow (ET) follow-up must not be overdue, even though it is < server UTC midnight');
});

test('a 6/23 follow-up is due today (not overdue) on the evening of 6/23 ET', () => {
  const c = mkClient({
    nextFollowUp: followUpDay('2026-06-23'), dealValue: 500,
    lastContact: followUpDay('2026-06-22'), updatedAt: followUpDay('2026-06-22'),
    log: [{ at: followUpDay('2026-06-22'), text: 'touch', kind: 'call' }],
  });
  assert.ok(!overdueTypes(c).includes('overdue_followup'), 'today is not overdue');
});

test('a 6/22 follow-up IS overdue on the evening of 6/23 ET', () => {
  const c = mkClient({
    nextFollowUp: followUpDay('2026-06-22'), dealValue: 500,
    lastContact: followUpDay('2026-06-22'), updatedAt: followUpDay('2026-06-22'),
    log: [{ at: followUpDay('2026-06-22'), text: 'touch', kind: 'call' }],
  });
  const overdue = classifyHeadsUp(c, ET_EVENING_NOW, ET_START)
    .find((i) => i.type === 'overdue_followup');
  assert.ok(overdue, 'a past ET day must be overdue');
  assert.match(overdue.message, /1 day overdue/);
});

// ── Cold-outreach prospects stay OUT of "Needs attention" ─────────────────────
// The lead-finder creates a CRM card per discovered dispensary so the outreach
// engine can enroll it. Once cold-emailed, the send logs an 'email' touch — which
// must NOT make the prospect look "worked" and demand a next step (that flooded the
// dashboard). A not-yet-warm, owner-untouched, unscheduled prospect earns ZERO items.
test('an enrolled+emailed cold prospect is suppressed from the heads-up feed', () => {
  const c = mkClient({
    stage: 'lead', dealValue: 0, nextFollowUp: null, lastContact: null,
    tags: ['dispensary', 'cold-email'],
    // the automated cold send logged an 'email' entry — the trap that used to
    // defeat the old `everContacted` suppression.
    log: [{ at: daysAgo(2), text: 'Cold email sent', kind: 'email' }],
    updatedAt: daysAgo(2),
  });
  assert.deepEqual(typesFor(c), [], 'a cold, un-warmed prospect earns no attention items');
});

test('the owner personally touching a prospect (call) resurfaces it', () => {
  const c = mkClient({
    stage: 'lead', dealValue: 0, nextFollowUp: null, lastContact: daysAgo(1),
    tags: ['dispensary', 'cold-email'],
    log: [{ at: daysAgo(1), text: 'Called, interested', kind: 'call' }],
    updatedAt: daysAgo(1),
  });
  // A real human touch means it's the owner's lead now → it should ask for a next step.
  assert.ok(typesFor(c).includes('no_next_step'), 'an owner-touched prospect wants a next step');
});

test('a replied (warm) prospect resurfaces even before the owner logs a call', () => {
  // warm-handoff stamps 'warm' + a follow-up on reply; a warm card is never suppressed.
  const c = mkClient({
    stage: 'contacted', dealValue: 0, nextFollowUp: daysAhead(-2), lastContact: daysAgo(1),
    tags: ['dispensary', 'cold-email', 'warm'],
    log: [{ at: daysAgo(1), text: 'They replied', kind: 'email' }],
    updatedAt: daysAgo(1),
  });
  assert.ok(typesFor(c).includes('overdue_followup'), 'a warm lead past its follow-up surfaces');
});

// ── Snooze hard-hides a card until it expires ─────────────────────────────────
test('a snoozed card earns no heads-up items until the snooze passes', () => {
  // Would normally be an overdue, high-value hot-quiet screamer...
  const base = mkClient({
    stage: 'quoting', dealValue: 5000, nextFollowUp: daysAhead(-3), lastContact: daysAgo(30),
  });
  assert.ok(typesFor(base).length > 0, 'baseline card does earn items');

  // ...but snoozed into the future → completely silent.
  const snoozed = { ...base, snoozedUntil: daysAhead(5) };
  assert.deepEqual(typesFor(snoozed), [], 'a future snooze hides everything');

  // A snooze already in the past no longer suppresses (it auto-returns).
  const expired = { ...base, snoozedUntil: daysAgo(1) };
  assert.ok(typesFor(expired).length > 0, 'an expired snooze lets the card resurface');
});
