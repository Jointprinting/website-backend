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

test('campaignHealth: all held by suppression → action naming suppressed + Requeue', () => {
  // The exact "72 enrolled · 0 sent · 0 active" case: name suppressed, point at Requeue.
  const h = campaignHealth({ status: 'active' }, { enrolled: 72, active: 0, sent: 0, suppressed: 66, noEmail: 0, failed: 0 });
  assert.equal(h.level, 'action');
  assert.match(h.label, /66 held/);
  assert.match(h.hint, /Requeue dropped/);
});

test('campaignHealth: all sends failed → action naming failures + Requeue', () => {
  const h = campaignHealth({ status: 'active' }, { enrolled: 30, active: 0, sent: 0, failed: 30, noEmail: 0, suppressed: 0 });
  assert.equal(h.level, 'action');
  assert.match(h.label, /30 sends failed/);
});

test('campaignHealth: roster exhausted (some sent, none active/completed) is NOT false-green', () => {
  const h = campaignHealth({ status: 'active' }, { enrolled: 10, active: 0, sent: 10, completed: 0, replied: 0 });
  assert.equal(h.level, 'warn');
  assert.equal(h.label, 'Roster exhausted');
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
  // A globally-suppressed address (unsubscribed / bounced somewhere) is blocked
  // even when everything else is fine.
  assert.equal(enrollBlockReason(lead, false, false, true), 'suppressed');
  assert.equal(enrollBlockReason(lead, false, false, false), '');
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

// ── Wave 5b: bounce/complaint classification ──────────────────────────────────
const { classifyBounceEvent } = require('../outreach');
test('classifyBounceEvent splits complaint / hard / soft / unknown', () => {
  assert.equal(classifyBounceEvent({ event: 'spam_complaint', email: 'a@b.com' }), 'complaint');
  assert.equal(classifyBounceEvent({ type: 'hard_bounce', to: 'a@b.com' }), 'hard');
  assert.equal(classifyBounceEvent({ notification_type: 'Bounce', bounce: { bounceType: 'Permanent' } }), 'hard');
  assert.equal(classifyBounceEvent({ status: 'soft_bounce' }), 'soft');
  assert.equal(classifyBounceEvent({ reason: 'mailbox full', category: 'temporary' }), 'soft');
  assert.equal(classifyBounceEvent({ email: 'a@b.com' }), 'unknown'); // no event field
});

// ── Wave 6: per-step drop-off funnel + bounce/unsub health ────────────────────
const { buildStepFunnel } = require('../outreach');
test('buildStepFunnel attributes sends/opens per touch and reply/unsub to the last touch', () => {
  const enr = [
    // received touch 0 + 1, opened touch 0, replied after touch 1
    { status: 'replied', sends: [{ stepIndex: 0, openedAt: new Date() }, { stepIndex: 1 }] },
    // received touch 0 only, unsubscribed after it
    { status: 'unsubscribed', sends: [{ stepIndex: 0 }] },
    // received touches 0,1,2 — still active
    { status: 'active', sends: [{ stepIndex: 0 }, { stepIndex: 1 }, { stepIndex: 2, openedAt: new Date() }] },
    { status: 'active', sends: [] }, // never sent
  ];
  const f = buildStepFunnel(enr);
  assert.equal(f.length, 3);
  assert.equal(f[0].sent, 3);          // three leads got touch 0
  assert.equal(f[0].opened, 1);
  assert.equal(f[0].unsubscribed, 1);  // unsub attributed to touch 0 (their last)
  assert.equal(f[1].sent, 2);
  assert.equal(f[1].replied, 1);       // reply attributed to touch 1 (their last)
  assert.equal(f[2].sent, 1);
  assert.equal(f[2].opened, 1);
});

test('buildStepFunnel is empty for no data', () => {
  assert.deepEqual(buildStepFunnel([]), []);
  assert.deepEqual(buildStepFunnel(), []);
});

test('campaignHealth flags a high bounce rate as action (deliverability first)', () => {
  const h = campaignHealth({ status: 'active' }, { enrolled: 40, active: 10, sent: 30, replied: 1, bounced: 4 });
  assert.equal(h.level, 'action');
  assert.match(h.label, /bouncing/);
});

test('campaignHealth flags a high unsubscribe rate as warn', () => {
  const h = campaignHealth({ status: 'active' }, { enrolled: 40, active: 20, sent: 30, replied: 1, unsubscribed: 2 });
  assert.equal(h.level, 'warn');
  assert.match(h.label, /unsubscribe/i);
});

// ── Wave 6b: next-best-action feed ────────────────────────────────────────────
const { buildNextActions } = require('../outreach');
test('buildNextActions ranks blockers first, then warm, then nudges', () => {
  const a = buildNextActions({
    engine: { senderConfigured: true, authGate: true, auth: { level: 'red' }, deliverability: { tripped: false } },
    campaigns: [{ _id: 'c1', name: 'Dispo', status: 'active', health: { level: 'action', hint: 'Nothing sending' } }],
    warmCount: 3,
    coldReserve: 50,
  });
  assert.equal(a[0].level, 'action');
  assert.ok(a.some((x) => x.level === 'warm' && /warm lead/i.test(x.text)));
  assert.ok(a.some((x) => /SPF|DMARC|authenticated/i.test(x.text)));
});

test('buildNextActions: all-clear yields a single ok item', () => {
  const a = buildNextActions({
    engine: { senderConfigured: true, authGate: true, auth: { level: 'green' }, deliverability: { tripped: false } },
    campaigns: [{ _id: 'c1', name: 'Dispo', status: 'active', health: { level: 'ok' } }],
    warmCount: 0,
    coldReserve: 5,
  });
  assert.equal(a.length, 1);
  assert.equal(a[0].level, 'ok');
});

test('buildNextActions: no active campaign but reserve → launch nudge', () => {
  const a = buildNextActions({ engine: { senderConfigured: true }, campaigns: [], warmCount: 0, coldReserve: 40 });
  assert.ok(a.some((x) => /launch one/i.test(x.text)));
});

// ── test-send handler (first-run wizard) ─────────────────────────────────────
// A tiny res double so we can assert the status/JSON without Express.
function mockRes() {
  return {
    _status: 200, _json: null,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
  };
}

test('sendTest: no sender configured → 400 with a fix-your-config message', async () => {
  const { sendTest } = require('../outreach');
  const saved = { from: process.env.OUTREACH_EMAIL_FROM, senders: process.env.OUTREACH_SENDERS };
  delete process.env.OUTREACH_EMAIL_FROM;
  delete process.env.OUTREACH_SENDERS;
  try {
    const res = mockRes();
    await sendTest({ body: { to: 'me@example.com' } }, res);
    assert.equal(res._status, 400);
    assert.match(res._json.message, /OUTREACH_EMAIL_FROM/);
  } finally {
    if (saved.from != null) process.env.OUTREACH_EMAIL_FROM = saved.from;
    if (saved.senders != null) process.env.OUTREACH_SENDERS = saved.senders;
  }
});

// ── Subject A/B results + subjectB round-trip ────────────────────────────────
const { summarizeAbTest } = require('../outreach');

test('summarizeAbTest: splits results by first stamped variant; opens/replies count once per company', () => {
  const rows = [
    { status: 'active',  sends: [{ variant: 'A' }], openCount: 0 },
    { status: 'active',  sends: [{ variant: 'A', openedAt: new Date() }] },
    { status: 'replied', sends: [{ variant: 'B' }, { variant: 'B' }], openCount: 3 },
    { status: 'active',  sends: [{ variant: '' }] },   // pre-test send — ignored
    null,
  ];
  const ab = summarizeAbTest(rows);
  assert.deepEqual(ab.A, { sent: 2, opened: 1, replied: 0 });
  assert.deepEqual(ab.B, { sent: 1, opened: 1, replied: 1 });
});

test('summarizeAbTest: null when no send carries a variant (no test running)', () => {
  assert.equal(summarizeAbTest([{ status: 'active', sends: [{ variant: '' }] }]), null);
  assert.equal(summarizeAbTest([]), null);
});

test('sanitizeSteps keeps subjectB and defaults it to empty', () => {
  const steps = sanitizeSteps([
    { subject: 'a', body: 'b', subjectB: 'alt line' },
    { subject: 'c', body: 'd', offsetDays: 3 },
  ]);
  assert.equal(steps[0].subjectB, 'alt line');
  assert.equal(steps[1].subjectB, '');
});

test('enrollBlockReason: personally-contacted companies are blocked at the WRITE path', () => {
  const lead = { stage: 'lead', email: 'x@y.com' };
  // The pick-list already hides these; this guards raw API calls / stale dialogs.
  assert.equal(enrollBlockReason({ ...lead, lastContact: new Date() }, false, false), 'already-contacted');
  assert.equal(enrollBlockReason({ ...lead, lastContact: null }, false, false), '');
});
