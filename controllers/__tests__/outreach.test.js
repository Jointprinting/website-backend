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
  enrollBlockReason,
  sanitizeSteps,
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

// ── Enroll eligibility ───────────────────────────────────────────────────────
test('enrollBlockReason: every gate fires with its own reason', () => {
  const lead = { stage: 'lead', email: 'x@y.com' };
  assert.equal(enrollBlockReason(null, false), 'not-found');
  assert.equal(enrollBlockReason(lead, true), 'already-enrolled');
  assert.equal(enrollBlockReason({ ...lead, archived: true }, false), 'archived');
  assert.equal(enrollBlockReason({ ...lead, doNotEmail: true }, false), 'do-not-email');
  assert.equal(enrollBlockReason({ ...lead, stage: 'lost' }, false), 'closed-stage');
  assert.equal(enrollBlockReason({ ...lead, stage: 'customer' }, false), 'became-customer');
  assert.equal(enrollBlockReason({ stage: 'lead' }, false), 'no-email');
  assert.equal(enrollBlockReason(lead, false), '');
  // Contact-level email is enough.
  assert.equal(enrollBlockReason({ stage: 'lead', contacts: [{ email: 'c@d.com' }] }, false), '');
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
