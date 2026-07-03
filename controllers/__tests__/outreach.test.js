// controllers/__tests__/outreach.test.js
//
// Pure-logic checks for the outreach controller (no DB):
//
//   node --test controllers/__tests__/outreach.test.js
//
// summarizeEnrollments / enrollBlockReason / sanitizeSteps are exported from
// controllers/outreach.js and take plain POJOs.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeEnrollments,
  campaignHealth,
  enrollBlockReason,
  sanitizeSteps,
  extractBounceEmails,
} = require('../outreach');

// ── Funnel math ──────────────────────────────────────────────────────────────
test('summarizeEnrollments counts companies per funnel stage', () => {
  const rows = [
    { status: 'active', sends: [] },                                  // enrolled, not yet sent
    { status: 'active', sends: [{ at: new Date() }] },                // sent
    { status: 'active', sends: [{ at: new Date() }], openCount: 2 },  // opened
    { status: 'replied', sends: [{}, {}], openCount: 1 },             // replied (also opened/sent)
    { status: 'completed', sends: [{}, {}, {}] },                     // ran dry
    { status: 'unsubscribed', sends: [{}] },
    { status: 'stopped', sends: [] },
    { status: 'failed', sends: [] },
    null,                                                             // garbage row ignored
  ];
  const s = summarizeEnrollments(rows);
  assert.equal(s.enrolled, 8);
  assert.equal(s.active, 3);
  assert.equal(s.sent, 5);
  assert.equal(s.opened, 2);
  assert.equal(s.replied, 1);
  assert.equal(s.completed, 1);
  assert.equal(s.unsubscribed, 1);
  assert.equal(s.stopped, 1);
  assert.equal(s.failed, 1);
});

test('summarizeEnrollments: empty/missing input yields zeroes', () => {
  const zero = summarizeEnrollments([]);
  assert.equal(zero.enrolled, 0);
  assert.equal(zero.sent, 0);
  assert.deepEqual(summarizeEnrollments(), zero);
});

test('summarizeEnrollments breaks out no-email stops separately', () => {
  const rows = [
    { status: 'stopped', stopReason: 'no-email', sends: [] },
    { status: 'stopped', stopReason: 'no-email', sends: [] },
    { status: 'stopped', stopReason: 'became-customer', sends: [] },
    { status: 'active', sends: [{ at: new Date() }] },
  ];
  const s = summarizeEnrollments(rows);
  assert.equal(s.stopped, 3);
  assert.equal(s.noEmail, 2);
});

// ── Campaign health (the "why isn't it sending?" signal) ─────────────────────
test('campaignHealth: draft / paused report their own state', () => {
  assert.equal(campaignHealth({ status: 'draft' }, {}).level, 'warn');
  assert.equal(campaignHealth({ status: 'draft' }, {}).label, 'Draft');
  assert.equal(campaignHealth({ status: 'paused' }, { enrolled: 5 }).label, 'Paused');
});

test('campaignHealth: active + all no-email → action, names the exact problem', () => {
  const h = campaignHealth({ status: 'active' }, { enrolled: 48, active: 0, sent: 0, noEmail: 48 });
  assert.equal(h.level, 'action');
  assert.match(h.label, /48 missing email/);
});

test('campaignHealth: active, nothing left in sequence, none sent → action', () => {
  const h = campaignHealth({ status: 'active' }, { enrolled: 10, active: 0, sent: 0, noEmail: 0 });
  assert.equal(h.level, 'action');
  assert.equal(h.label, 'Nothing sending');
});

test('campaignHealth: sequence complete → warn (enroll fresh leads)', () => {
  const h = campaignHealth({ status: 'active' }, { enrolled: 10, active: 0, sent: 10, completed: 10 });
  assert.equal(h.level, 'warn');
  assert.equal(h.label, 'Sequence complete');
});

test('campaignHealth: healthy active drip → ok', () => {
  const h = campaignHealth({ status: 'active' }, { enrolled: 20, active: 15, sent: 5, replied: 1 });
  assert.equal(h.level, 'ok');
  assert.equal(h.label, 'Sending');
});

test('campaignHealth: no enrollments yet → warn', () => {
  assert.equal(campaignHealth({ status: 'active' }, { enrolled: 0 }).label, 'No leads yet');
});

// ── Enroll eligibility ───────────────────────────────────────────────────────
test('enrollBlockReason: every gate fires with its own reason', () => {
  const lead = { stage: 'lead', email: 'x@y.com' };
  assert.equal(enrollBlockReason(null, false, false), 'not-found');
  assert.equal(enrollBlockReason(lead, true, false), 'already-enrolled');
  // Order-reality customer is blocked even at an early stored stage (client protection).
  assert.equal(enrollBlockReason(lead, false, true), 'is-customer');
  assert.equal(enrollBlockReason({ ...lead, archived: true }, false, false), 'archived');
  assert.equal(enrollBlockReason({ ...lead, doNotEmail: true }, false, false), 'do-not-email');
  assert.equal(enrollBlockReason({ ...lead, stage: 'lost' }, false, false), 'closed-stage');
  assert.equal(enrollBlockReason({ ...lead, stage: 'customer' }, false, false), 'became-customer');
  assert.equal(enrollBlockReason({ stage: 'lead' }, false, false), 'no-email');
  assert.equal(enrollBlockReason(lead, false, false), '');
  // Contact-level email is enough.
  assert.equal(enrollBlockReason({ stage: 'lead', contacts: [{ email: 'c@d.com' }] }, false, false), '');
});

// ── Step sanitizing (the campaign editor's server-side guardrails) ───────────
test('sanitizeSteps: first step is day-0, later offsets clamp to ≥1, blanks drop', () => {
  const steps = sanitizeSteps([
    { offsetDays: 5, subject: 'Intro', body: 'Hi {{firstName|there}}' },
    { offsetDays: -2, subject: 'Bump', body: 'Just floating this up' },
    { offsetDays: 2.6, subject: 'Break', body: 'Last one' },
    { subject: '   ', body: '' },                     // empty → dropped
  ]);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].offsetDays, 0);   // first send is due at enroll time
  assert.equal(steps[1].offsetDays, 1);   // negative clamped
  assert.equal(steps[2].offsetDays, 3);   // rounded
  assert.equal(steps[0].subject, 'Intro');
});

test('sanitizeSteps tolerates garbage input', () => {
  assert.deepEqual(sanitizeSteps(null), []);
  assert.deepEqual(sanitizeSteps('nope'), []);
  assert.deepEqual(sanitizeSteps([null, undefined, {}]), []);
});

// ── Bounce email extraction (provider-agnostic) ──────────────────────────────
test('extractBounceEmails digs emails out of any payload shape', () => {
  // SendPulse-style array of events
  assert.deepEqual(
    extractBounceEmails([{ event: 'hard_bounce', email: 'DEAD@shop.com' }, { email: 'gone@x.io' }]).sort(),
    ['dead@shop.com', 'gone@x.io'],
  );
  // Nested single object with a recipient key
  assert.deepEqual(extractBounceEmails({ data: { recipient: 'no-one@nope.com' } }), ['no-one@nope.com']);
  // Deduped + only email-keyed strings (a random text field is ignored)
  assert.deepEqual(
    extractBounceEmails({ to: 'a@b.com', note: 'contact c@d.com by phone', address: 'a@b.com' }),
    ['a@b.com'],
  );
  assert.deepEqual(extractBounceEmails({}), []);
  assert.deepEqual(extractBounceEmails(null), []);
});
