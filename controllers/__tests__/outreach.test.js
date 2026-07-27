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
  autoEnrollOnFromState,
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

test('campaignHealth: only a genuinely bad list (≥12% of ≥30 sent) is still action', () => {
  // 4/30 = 13.3% at real volume — past what auto-hygiene can save; the owner
  // has to pause and rebuild the list source.
  const h = campaignHealth({ status: 'active' }, { enrolled: 40, active: 10, sent: 30, replied: 1, bounced: 4 });
  assert.equal(h.level, 'action');
  assert.match(h.label, /bouncing/);
  assert.match(h.hint, /quarantines new first-touches automatically/);
});

test('campaignHealth: moderate bounces → warn that reports the automation, not a chore', () => {
  // The owner's exact card: 2 of 20 bounced. The machine already suppressed the
  // bounced addresses and auto-enroll refills the roster — say so instead of
  // the old "pause and clean the list before you keep sending".
  const h = campaignHealth({ status: 'active' }, { enrolled: 40, active: 20, sent: 20, replied: 1, bounced: 2 });
  assert.equal(h.level, 'warn');
  assert.match(h.label, /auto-cleaned/);
  assert.match(h.hint, /auto-removed/);
  assert.match(h.hint, /auto-enroll refills/);
  assert.match(h.hint, /no action needed yet/i);
  assert.doesNotMatch(h.hint, /pause and clean/i);
  assert.doesNotMatch(h.hint, /re-verified/); // hygiene hasn't run → don't claim it did
});

test('campaignHealth: mentions the roster re-verify (and drop count) only when hygiene ran recently', () => {
  const now = new Date('2026-07-07T12:00:00Z');
  const stats = { enrolled: 40, active: 20, sent: 20, replied: 1, bounced: 2, cleaned: 3 };
  // Hygiene stamped 12h ago → report the re-verify + how many it dropped.
  const fresh = campaignHealth({ status: 'active', lastHygieneAt: new Date('2026-07-07T00:00:00Z') }, stats, now);
  assert.equal(fresh.level, 'warn');
  assert.match(fresh.hint, /re-verified the waiting roster/);
  assert.match(fresh.hint, /dropping 3 dead addresses/);
  // Stamped 3 days ago → stale; the current numbers postdate it, so don't claim it.
  const stale = campaignHealth({ status: 'active', lastHygieneAt: new Date('2026-07-04T00:00:00Z') }, stats, now);
  assert.doesNotMatch(stale.hint, /re-verified/);
});

test('campaignHealth bounce thresholds: warn from ≥5% of ≥10 sent; action only at ≥12% of ≥30', () => {
  const mk = (sent, bounced) => campaignHealth({ status: 'active' }, { enrolled: 200, active: 10, sent, bounced, replied: 3 });
  assert.equal(mk(10, 1).level, 'warn');     // 10% of 10 — the warn floor
  assert.equal(mk(9, 5).level, 'ok');        // under the 10-sent sample floor
  assert.equal(mk(100, 4).level, 'ok');      // 4% — below the warn rate
  assert.equal(mk(29, 4).level, 'warn');     // 13.8% but under the 30-sent action floor
  assert.equal(mk(100, 11).level, 'warn');   // 11% — high, still auto-managed
  assert.equal(mk(100, 12).level, 'action'); // 12% at volume — a genuinely bad list
});

test('summarizeEnrollments: hygiene-dropped rows count as cleaned, not bounced', () => {
  const rows = [
    { status: 'stopped', stopReason: 'invalid-address', sends: [] },             // hygiene drop (pre-send)
    { status: 'failed', stopReason: 'invalid-address', sends: [] },              // SMTP bounce on touch 1
    { status: 'failed', stopReason: 'bounced', sends: [{ at: new Date() }] },    // webhook hard bounce
    { status: 'failed', stopReason: 'complaint', sends: [{ at: new Date() }] },  // spam complaint
  ];
  const s = summarizeEnrollments(rows);
  assert.equal(s.cleaned, 1);
  assert.equal(s.bounced, 3);
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

test('buildNextActions: active campaign + Gmail sync OFF → loud reply-auto-stop warning', () => {
  const base = {
    engine: { senderConfigured: true, authGate: true, auth: { level: 'green' }, deliverability: { tripped: false } },
    campaigns: [{ _id: 'c1', name: 'Dispo', status: 'active', health: { level: 'ok' } }],
    warmCount: 0, coldReserve: 5,
  };
  // Sync off while sending → red action item pointing at the replies view.
  const off = buildNextActions({ ...base, replySyncOn: false });
  const warn = off.find((x) => /replies are not being auto-detected/i.test(x.text));
  assert.ok(warn, 'expected the reply-sync warning');
  assert.equal(warn.level, 'action');
  assert.deepEqual(warn.cta, { view: 'replies' });
  // Sync on (or omitted → default true, the legacy shape) → no warning.
  assert.equal(buildNextActions({ ...base, replySyncOn: true }).some((x) => /auto-detected/i.test(x.text)), false);
  assert.equal(buildNextActions(base).some((x) => /auto-detected/i.test(x.text)), false);
  // No active campaign → nothing is sending, so no warning even when sync is off.
  const idle = buildNextActions({ ...base, campaigns: [], replySyncOn: false });
  assert.equal(idle.some((x) => /auto-detected/i.test(x.text)), false);
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

// ── Per-city spread in the daily enroll draw ─────────────────────────────────
const { interleaveByCity } = require('../outreach');

test('interleaveByCity: round-robins across cities, preserving order within each', () => {
  // Arrival order = best-score-first (Newark holds ranks 1–3, so plain
  // best-first would send all of Newark before anyone else).
  const rows = [
    { name: 'nwk-1', city: 'Newark' },
    { name: 'nwk-2', city: 'Newark' },
    { name: 'nwk-3', city: 'Newark' },
    { name: 'trn-1', city: 'Trenton' },
    { name: 'cmd-1', city: 'Camden' },
    { name: 'trn-2', city: 'Trenton' },
  ];
  assert.deepEqual(interleaveByCity(rows).map((r) => r.name), [
    'nwk-1', 'trn-1', 'cmd-1',   // one from each city, best-city first
    'nwk-2', 'trn-2',            // second round (Camden is spent)
    'nwk-3',                     // Newark's tail drains last
  ]);
});

test('interleaveByCity: unknown-city leads form their own bucket, drawn LAST', () => {
  const rows = [
    { name: 'mystery-1', city: '' },       // best score but no parseable city
    { name: 'nwk-1', city: 'Newark' },
    { name: 'mystery-2' },                 // missing entirely
    { name: 'trn-1', city: 'Trenton' },
  ];
  assert.deepEqual(interleaveByCity(rows).map((r) => r.name),
    ['nwk-1', 'trn-1', 'mystery-1', 'mystery-2']);
});

test('interleaveByCity: city matching is case/space-insensitive; custom accessor; empty in → empty out', () => {
  // "newark" and "Newark " are ONE bucket — otherwise casing would fake spread.
  const rows = [
    { name: 'a', city: 'Newark ' },
    { name: 'b', city: 'newark' },
    { name: 'c', city: 'Trenton' },
  ];
  assert.deepEqual(interleaveByCity(rows).map((r) => r.name), ['a', 'c', 'b']);
  // The enroll path passes a custom accessor ({ c, sc, city } wrappers).
  const wrapped = [{ v: 1, town: 'X' }, { v: 2, town: 'Y' }, { v: 3, town: 'X' }];
  assert.deepEqual(interleaveByCity(wrapped, (r) => r.town).map((r) => r.v), [1, 2, 3]);
  assert.deepEqual(interleaveByCity([]), []);
  assert.deepEqual(interleaveByCity(), []);
});

// ── Subject A/B auto-winner (conservative lock) ───────────────────────────────
const { decideAbWinner } = require('../outreach');
test('decideAbWinner locks only on decisive, high-volume results', () => {
  const arm = (sent, replied) => ({ sent, opened: 0, replied });
  // Decisive: both arms at volume, leader doubles the laggard with real replies.
  assert.equal(decideAbWinner({ A: arm(60, 6), B: arm(60, 2) }), 'A');
  assert.equal(decideAbWinner({ A: arm(50, 1), B: arm(50, 5) }), 'B');
  // Laggard at zero replies: leader still needs its absolute floor.
  assert.equal(decideAbWinner({ A: arm(45, 4), B: arm(45, 0) }), 'A');
  // NOT decisive → keep testing:
  assert.equal(decideAbWinner({ A: arm(20, 5), B: arm(60, 1) }), '');   // one arm under volume
  assert.equal(decideAbWinner({ A: arm(60, 3), B: arm(60, 0) }), '');   // too few absolute replies
  assert.equal(decideAbWinner({ A: arm(100, 6), B: arm(100, 4) }), ''); // gap under 2×
  assert.equal(decideAbWinner(null), '');
  assert.equal(decideAbWinner({ A: arm(60, 6) }), '');                  // missing arm
});

// ── Auto-enroll is ON by default (task #102) ─────────────────────────────────
// Cold leads should flow into the active campaign automatically — the owner
// never has to click "Auto-enroll." It's OFF only when they explicitly disable it.
test('autoEnrollOnFromState: ON by default, OFF only when explicitly disabled', () => {
  assert.equal(autoEnrollOnFromState(null), true, 'fresh install / no state = on');
  assert.equal(autoEnrollOnFromState({}), true, 'no flag = on');
  assert.equal(autoEnrollOnFromState({ autoEnrollDisabled: false }), true);
  assert.equal(autoEnrollOnFromState({ autoEnrollDisabled: true }), false, 'explicit owner off');
  // A pinned campaign with the flag off is still on (the pointer doesn't gate it).
  assert.equal(autoEnrollOnFromState({ autoEnrollCampaignId: 'abc' }), true);
});

test('buildNextActions: no "cold leads waiting" nudge when auto-enroll is on (nothing waits on the owner)', () => {
  const base = {
    engine: { senderConfigured: true },
    campaigns: [{ _id: 'c1', name: 'Dispensaries', status: 'active' }],
    warmCount: 0, coldReserve: 44, replySyncOn: true,
  };
  const withAuto = buildNextActions({ ...base, autoEnrollOn: true });
  assert.ok(!withAuto.some(a => /cold leads waiting/i.test(a.text)),
    'auto-enroll on → the reserve flows automatically, so no manual-enroll nudge');

  const noAuto = buildNextActions({ ...base, autoEnrollOn: false });
  assert.ok(noAuto.some(a => /cold leads waiting/i.test(a.text)),
    'auto-enroll explicitly off → the manual-enroll nudge still fires');
});

// ── The dead sequence: one touch and nobody ever gets a follow-up ────────────
test('campaignHealth: an active one-touch campaign is an ACTION, named plainly', () => {
  const h = campaignHealth(
    { status: 'active', steps: [{ subject: 'Intro', body: 'hi' }] },
    { enrolled: 349, active: 349, sent: 272, replied: 0 },
  );
  assert.equal(h.level, 'action');
  assert.equal(h.label, 'One-touch sequence');
  assert.match(h.hint, /nobody ever gets a follow-up/i);
  assert.match(h.hint, /day-3/);
  // A campaign with NO usable steps at all is the same dead end.
  assert.equal(campaignHealth({ status: 'active', steps: [] }, { enrolled: 5, active: 5, sent: 1 }).label, 'One-touch sequence');
});

test('campaignHealth: two or more touches clears the one-touch alarm', () => {
  const steps = [{ subject: 'Intro' }, { subject: 'Bump', offsetDays: 3 }];
  const h = campaignHealth({ status: 'active', steps }, { enrolled: 20, active: 15, sent: 5, replied: 1 });
  assert.equal(h.level, 'ok');
  assert.equal(h.label, 'Sending');
});

test('campaignHealth: one-touch outranks the deliverability reads, but not "not sending at all"', () => {
  const one = [{ subject: 'Intro' }];
  // A bounce-rate warn on a one-touch campaign still reports the one-touch first —
  // a sequence nobody follows up is the bigger problem.
  const bouncing = campaignHealth({ status: 'active', steps: one }, { enrolled: 40, active: 20, sent: 20, bounced: 2, replied: 1 });
  assert.equal(bouncing.label, 'One-touch sequence');
  // But "0 enrolled" / "nothing can send" still name the real blocker.
  assert.equal(campaignHealth({ status: 'active', steps: one }, { enrolled: 0 }).label, 'No leads yet');
  assert.equal(campaignHealth({ status: 'paused', steps: one }, { enrolled: 9 }).label, 'Paused');
});

test('campaignHealth: a stats-only read (no steps field) never invents the one-touch alarm', () => {
  // The analytics/overview callers always pass the campaign doc (steps present).
  // A caller that has only funnel stats knows nothing about the sequence — it
  // must not manufacture a red alert out of a missing field.
  const h = campaignHealth({ status: 'active' }, { enrolled: 20, active: 15, sent: 5, replied: 1 });
  assert.equal(h.level, 'ok');
});

// ── campaignHealth: the quarantined banner reports what the machine DID ───────
test('campaignHealth: a quarantined campaign reports the auto-action, not a chore', () => {
  const h = campaignHealth(
    { status: 'active', firstTouchQuarantinedAt: new Date(), quarantineReason: '14 of 98 sent bounced or complained even after auto-cleaning' },
    { enrolled: 120, active: 5, sent: 98, bounced: 14, replied: 0, completed: 0, unsubscribed: 0, noEmail: 0, cleaned: 0 },
  );
  assert.equal(h.level, 'warn');
  assert.equal(h.label, 'List quarantined');
  assert.match(h.hint, /stopped NEW first-touches automatically/);
  assert.match(h.hint, /14 of 98/);
});

// ── The reply black hole + the dead sequence, in the ranked to-do list ────────
const { planReArm, fieldMapExclusions, sanitizeEnrollFilters } = require('../outreach');

test('buildNextActions: a broken reply path is an ACTION, shown verbatim, above warm leads', () => {
  const hint = 'Replies to your cold email land in send@shop.example, but the Studio reads owner@real.example — you will never see them. Fix: set the reply-to on the API, or turn on forwarding from the sending mailbox.';
  const a = buildNextActions({
    engine: { senderConfigured: true, authGate: true, auth: { level: 'green' }, deliverability: { tripped: false },
      replyPath: { level: 'action', hint, destination: 'send@shop.example', monitored: false } },
    campaigns: [{ _id: 'c1', name: 'Dispo', status: 'active', health: { level: 'ok' } }],
    warmCount: 4, coldReserve: 5, replySyncOn: true,
  });
  const item = a.find((x) => x.text === hint);
  assert.ok(item, 'the reply-path hint is surfaced word for word (it already names both addresses)');
  assert.equal(item.level, 'action');
  assert.deepEqual(item.cta, { view: 'replies' });
  // Ranked above the warm-lead nudge.
  assert.ok(a.indexOf(item) < a.findIndex((x) => x.level === 'warm'));
});

test('buildNextActions: a healthy (or unknown) reply path adds nothing', () => {
  const base = {
    engine: { senderConfigured: true, authGate: true, auth: { level: 'green' }, deliverability: { tripped: false } },
    campaigns: [{ _id: 'c1', name: 'Dispo', status: 'active', health: { level: 'ok' } }],
    warmCount: 0, coldReserve: 5, replySyncOn: true,
  };
  assert.equal(buildNextActions(base).length, 1);                       // no replyPath at all
  assert.equal(buildNextActions({ ...base, engine: { ...base.engine, replyPath: { level: 'ok' } } }).length, 1);
  assert.equal(buildNextActions({ ...base, engine: { ...base.engine, replyPath: { level: 'warn', hint: 'x' } } }).length, 1);
  // 'action' with no hint text can't say anything useful — don't emit an empty row.
  assert.equal(buildNextActions({ ...base, engine: { ...base.engine, replyPath: { level: 'action', hint: '' } } }).length, 1);
});

test('buildNextActions: a one-touch sequence is an ACTION above warm leads, pointing at Campaigns', () => {
  const base = {
    engine: { senderConfigured: true, authGate: true, auth: { level: 'green' }, deliverability: { tripped: false } },
    campaigns: [{ _id: 'c1', name: 'Dispo', status: 'active', health: { level: 'ok' } }],
    warmCount: 2, coldReserve: 5, replySyncOn: true,
  };
  const a = buildNextActions({ ...base, noFollowUpsPossible: true });
  const item = a.find((x) => /single touch/i.test(x.text));
  assert.ok(item, 'expected the one-touch alarm');
  assert.equal(item.level, 'action');
  assert.deepEqual(item.cta, { view: 'campaigns' });
  assert.ok(a.indexOf(item) < a.findIndex((x) => x.level === 'warm'));
  // Off by default / when the sequence has follow-ups.
  assert.equal(buildNextActions(base).some((x) => /single touch/i.test(x.text)), false);
  assert.equal(buildNextActions({ ...base, noFollowUpsPossible: false }).some((x) => /single touch/i.test(x.text)), false);
});

// ── Re-arming the leads a too-short sequence already burned ──────────────────
const DAY = 86400000;
const steps3 = [{ offsetDays: 0, subject: 'Intro' }, { offsetDays: 3, subject: 'Bump' }, { offsetDays: 7, subject: 'Break' }];

test('planReArm: a burned one-touch lead resumes at the NEXT UNSENT touch, never a repeat', () => {
  const now = new Date('2026-07-27T12:00:00Z');
  const rows = [{
    _id: 'e1', companyKey: 'shop-a', toEmail: 'a@shop.com', status: 'completed', stepIndex: 0,
    sends: [{ stepIndex: 0, at: new Date(now - 20 * DAY) }],
  }];
  const { plan } = planReArm(rows, steps3, { now, rand: () => 0.5 });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].stepIndex, 1, 'they already got touch 0 — the next email is touch 1');
  // The owed date is 17 days past, so it floors to a jittered slot just ahead of
  // now rather than a backdated pile that all fires at once.
  assert.ok(plan[0].nextSendAt > now, 'never scheduled in the past');
  assert.ok(plan[0].nextSendAt - now <= 90 * 60 * 1000);
});

test('planReArm: a still-future offset is honoured from their LAST send, not from now', () => {
  const now = new Date('2026-07-27T12:00:00Z');
  const rows = [{
    _id: 'e1', companyKey: 'shop-a', toEmail: 'a@shop.com', status: 'completed', stepIndex: 0,
    sends: [{ stepIndex: 0, at: new Date(now.getTime() - 1 * DAY) }],
  }];
  const { plan } = planReArm(rows, steps3, { now, rand: () => 0.5 });
  // touch 1 is +3 days from the touch-0 send → 2 days out from now.
  assert.equal(plan[0].nextSendAt.getTime(), now.getTime() - DAY + 3 * DAY);
});

test('planReArm: reads the touch they RECEIVED off the sends, not the parked stepIndex', () => {
  const now = new Date('2026-07-27T12:00:00Z');
  const rows = [
    // Got touches 0 and 1; stepIndex is parked on 1 by the engine's completion path.
    { _id: 'e2', companyKey: 'b', toEmail: 'b@shop.com', status: 'completed', stepIndex: 1,
      sends: [{ stepIndex: 0, at: new Date(now - 30 * DAY) }, { stepIndex: 1, at: new Date(now - 27 * DAY) }] },
    // Enrolled into a campaign with no usable step — nothing ever sent, so touch 0 is owed.
    { _id: 'e3', companyKey: 'c', toEmail: 'c@shop.com', status: 'completed', stepIndex: 0, sends: [] },
  ];
  const { plan } = planReArm(rows, steps3, { now, rand: () => 0.5 });
  assert.deepEqual(plan.map((p) => [p._id, p.stepIndex]), [['e2', 2], ['e3', 0]]);
});

test('planReArm: guards — replied/active rows, finished sequences, suppression, do-not-email', () => {
  const now = new Date('2026-07-27T12:00:00Z');
  const send = [{ stepIndex: 0, at: new Date(now - 10 * DAY) }];
  const rows = [
    { _id: 'ok', companyKey: 'ok', toEmail: 'ok@shop.com', status: 'completed', stepIndex: 0, sends: send },
    // Non-'completed' rows are untouchable: a reply, an opt-out, a bounce, or a
    // lead still walking the sequence must never be rescheduled by a re-arm.
    { _id: 'replied', companyKey: 'r', toEmail: 'r@shop.com', status: 'replied', stepIndex: 0, sends: send },
    { _id: 'unsub', companyKey: 'u', toEmail: 'u@shop.com', status: 'unsubscribed', stepIndex: 0, sends: send },
    { _id: 'bounced', companyKey: 'x', toEmail: 'x@shop.com', status: 'failed', stopReason: 'bounced', stepIndex: 0, sends: send },
    { _id: 'active', companyKey: 'a', toEmail: 'a@shop.com', status: 'active', stepIndex: 1, sends: send },
    // Address suppressed via some OTHER campaign.
    { _id: 'supp', companyKey: 's', toEmail: 'Supp@Shop.com', status: 'completed', stepIndex: 0, sends: send },
    // Company the live send path would refuse (do-not-email / archived / customer).
    { _id: 'dne', companyKey: 'blocked-key', toEmail: 'd@shop.com', status: 'completed', stepIndex: 0, sends: send },
    // Already had every touch in the (still 3-step) sequence.
    { _id: 'done', companyKey: 'z', toEmail: 'z@shop.com', status: 'completed', stepIndex: 2,
      sends: [{ stepIndex: 0, at: new Date(now - 30 * DAY) }, { stepIndex: 1 }, { stepIndex: 2, at: new Date(now - 10 * DAY) }] },
  ];
  const { plan, skipped } = planReArm(rows, steps3, {
    now,
    blockedEmails: new Set(['supp@shop.com']),
    blockedKeys: new Set(['blocked-key']),
    rand: () => 0.5,
  });
  assert.deepEqual(plan.map((p) => p._id), ['ok']);
  assert.equal(skipped.blocked, 2);
  assert.equal(skipped.sequenceFinished, 1);
});

test('planReArm: idempotent — re-running over rows it already flipped plans nothing', () => {
  const now = new Date('2026-07-27T12:00:00Z');
  const row = { _id: 'e1', companyKey: 'a', toEmail: 'a@shop.com', status: 'completed', stepIndex: 0,
    sends: [{ stepIndex: 0, at: new Date(now - 10 * DAY) }] };
  const first = planReArm([row], steps3, { now, rand: () => 0.5 });
  assert.equal(first.plan.length, 1);
  // The write flips them to 'active' (filtered on status:'completed', so a
  // concurrent second write matches nothing) — and re-planning skips them.
  const applied = { ...row, status: 'active', stepIndex: first.plan[0].stepIndex };
  assert.equal(planReArm([applied], steps3, { now, rand: () => 0.5 }).plan.length, 0);
});

test('planReArm: tolerates garbage input', () => {
  assert.deepEqual(planReArm().plan, []);
  assert.deepEqual(planReArm([null, undefined], steps3).plan, []);
  assert.deepEqual(planReArm([{ _id: 'x', status: 'completed', sends: [] }], []).plan, []);
});

// ── List quality: reuse the Field Map's own read on the same shops ───────────
test('fieldMapExclusions: chains and non-retail shops are excluded, real dispensaries kept', () => {
  const rows = [
    { companyKey: 'rec-nj',   isChain: false, segment: 'rec',  state: 'NJ' },  // licensed adult-use
    { companyKey: 'med-pa',   isChain: false, segment: 'med',  state: 'PA' },  // licensed medical-only
    { companyKey: 'chain-il', isChain: true,  segment: 'rec',  state: 'IL' },  // corporate chain
    { companyKey: 'hemp-nj',  isChain: false, segment: 'hemp', state: 'NJ' },  // CBD shop in a legal state
    { companyKey: 'smoke-tx', isChain: false, segment: 'hemp', state: 'TX' },  // no legal retail market
    { companyKey: 'nolegal',  isChain: false, segment: '',     state: 'SC' },  // unstamped, still no market
  ];
  const { excluded, chains, nonRetail } = fieldMapExclusions(rows);
  assert.equal(excluded.has('rec-nj'), false);
  assert.equal(excluded.has('med-pa'), false);
  assert.equal(excluded.get('chain-il'), 'chain');
  assert.equal(excluded.get('hemp-nj'), 'non-retail');
  assert.equal(excluded.get('smoke-tx'), 'non-retail');
  assert.equal(excluded.get('nolegal'), 'non-retail');
  assert.equal(chains, 1);
  assert.equal(nonRetail, 3);
});

test('fieldMapExclusions: a company with no Field Map row is never excluded', () => {
  // Other verticals (breweries) aren't in the dispensary collection at all — the
  // filter must be inert for them, not a silent pool wipe.
  const { excluded, chains, nonRetail } = fieldMapExclusions([]);
  assert.equal(excluded.size, 0);
  assert.equal(chains, 0);
  assert.equal(nonRetail, 0);
  assert.deepEqual([...fieldMapExclusions(null).excluded.keys()], []);
});

test('fieldMapExclusions: multiple rows per shop — any chain row wins, one real retail row saves it', () => {
  const rows = [
    // Same shop, two sources: the roster row knows it's licensed retail.
    { companyKey: 'dual', isChain: false, segment: '',    state: 'US' },
    { companyKey: 'dual', isChain: false, segment: 'rec', state: 'CO' },
    // Same shop, one row flags the chain — that's a brand fact, so it holds.
    { companyKey: 'brand', isChain: false, segment: 'rec', state: 'MI' },
    { companyKey: 'brand', isChain: true,  segment: 'rec', state: 'MI' },
    { companyKey: '',      isChain: true,  segment: 'rec', state: 'MI' }, // keyless row ignored
  ];
  const { excluded } = fieldMapExclusions(rows);
  assert.equal(excluded.has('dual'), false);
  assert.equal(excluded.get('brand'), 'chain');
  assert.equal(excluded.size, 1);
});

test('fieldMapExclusions: the owner can opt each filter back in', () => {
  const rows = [
    { companyKey: 'chain-il', isChain: true, segment: 'rec', state: 'IL' },
    { companyKey: 'smoke-tx', isChain: false, segment: 'hemp', state: 'TX' },
  ];
  const chainsBack = fieldMapExclusions(rows, { includeChains: true });
  assert.equal(chainsBack.excluded.has('chain-il'), false);
  assert.equal(chainsBack.chains, 0, 'counts report what was actually skipped');
  assert.equal(chainsBack.excluded.get('smoke-tx'), 'non-retail');
  const allBack = fieldMapExclusions(rows, { includeChains: true, includeNonRetail: true });
  assert.equal(allBack.excluded.size, 0);
});

test('sanitizeEnrollFilters: both filters default ON (flags off) and only true opts back in', () => {
  assert.deepEqual(sanitizeEnrollFilters(), { includeChains: false, includeNonRetail: false });
  assert.deepEqual(sanitizeEnrollFilters(null), { includeChains: false, includeNonRetail: false });
  assert.deepEqual(sanitizeEnrollFilters({ includeChains: 'true', includeNonRetail: 1 }),
    { includeChains: true, includeNonRetail: false });
});
