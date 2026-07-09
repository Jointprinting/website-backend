// services/__tests__/outreach.test.js
//
// Pure-logic checks for the outreach sender engine (no DB, no SMTP):
//
//   node --test services/__tests__/outreach.test.js
//
// rampCap / isWithinSendWindow / renderTemplate / buildMergeContext /
// cityFromAddress / composeMessage / sendBlockReason are exported from
// services/outreachEngine.js and take plain values, so they're testable
// without Mongo. (The tick/send paths are DB-bound and exercised live.)

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  rampCap,
  senderKey,
  senderRampDays,
  isWithinSendWindow,
  renderTemplate,
  buildMergeContext,
  cityFromAddress,
  composeMessage,
  sendBlockReason,
  bodyToHtml,
  pickEmail,
  isPermanentSmtpError,
  isBadRecipientError,
  transientBackoffMs,
  jitteredFollowUpAt,
  variableBatch,
  outreachMessageId,
  SEND_PRIORITY_FILTERS,
} = require('../outreachEngine');

// ── Send-claim priority: warm follow-ups outrank new cold first touches ───────
test('SEND_PRIORITY_FILTERS claims follow-ups (stepIndex>0) before first touches', () => {
  assert.equal(Array.isArray(SEND_PRIORITY_FILTERS), true);
  assert.equal(SEND_PRIORITY_FILTERS.length, 2);
  // Pass 1 = follow-ups (a started conversation), pass 2 = new first touches.
  assert.deepEqual(SEND_PRIORITY_FILTERS[0], { stepIndex: { $gt: 0 } });
  assert.deepEqual(SEND_PRIORITY_FILTERS[1], { stepIndex: 0 });
  // A follow-up enrollment matches pass 1 but not pass 2; a first touch the reverse.
  const matches = (f, stepIndex) => (f.stepIndex.$gt != null ? stepIndex > f.stepIndex.$gt : stepIndex === f.stepIndex);
  assert.equal(matches(SEND_PRIORITY_FILTERS[0], 2), true);
  assert.equal(matches(SEND_PRIORITY_FILTERS[0], 0), false);
  assert.equal(matches(SEND_PRIORITY_FILTERS[1], 0), true);
  assert.equal(matches(SEND_PRIORITY_FILTERS[1], 2), false);
});

// ── Warm-up ramp (doubles weekly) ────────────────────────────────────────────
test('rampCap doubles each week and tops out at the max cap', () => {
  assert.equal(rampCap(0, 500), 10);    // week one
  assert.equal(rampCap(6, 500), 10);    // still week one
  assert.equal(rampCap(7, 500), 20);    // week two — doubled
  assert.equal(rampCap(13, 500), 20);
  assert.equal(rampCap(14, 500), 40);   // week three
  assert.equal(rampCap(21, 500), 80);   // week four
  assert.equal(rampCap(28, 500), 160);  // week five
  assert.equal(rampCap(35, 500), 320);  // week six
  assert.equal(rampCap(42, 500), 500);  // week seven — 640 clamped to cap
  assert.equal(rampCap(365, 500), 500); // never exceeds max
});

test('rampCap: no first send yet (or garbage) → week-one pace; cap wins early', () => {
  assert.equal(rampCap(null, 500), 10);
  assert.equal(rampCap(undefined, 500), 10);
  assert.equal(rampCap(-3, 500), 10);
  assert.equal(rampCap(NaN, 500), 10);
  assert.equal(rampCap(21, 50), 50);   // week-four geometric (80) clamped to a 50 cap
  assert.equal(rampCap(0, 5), 5);      // cap below the 10 floor still wins
});

// ── PER-INBOX warm-up: each pool inbox ramps from ITS OWN first send ──────────
test('senderKey sanitizes labels into legal Mongo map keys', () => {
  assert.equal(senderKey('gw1'), 'gw1');
  assert.equal(senderKey('gw.1'), 'gw_1');      // dots are illegal in Mongo keys
  assert.equal(senderKey('a$b.c'), 'a_b_c');
  assert.equal(senderKey(''), 'primary');       // blank → the legacy primary
  assert.equal(senderKey(null), 'primary');
});

test('senderRampDays: anchored inbox → its own age; unanchored → null', () => {
  const now = new Date('2026-07-06T12:00:00Z');
  const anchors = {
    gw1: new Date('2026-06-06T12:00:00Z'),  // 30 days old
    gw_2: new Date('2026-07-05T12:00:00Z'), // 1 day old (stored under sanitized key)
  };
  assert.equal(senderRampDays(anchors, 'gw1', now), 30);
  assert.equal(senderRampDays(anchors, 'gw.2', now), 1);   // label sanitizes to the stored key
  assert.equal(senderRampDays(anchors, 'brand-new', now), null); // never sent
  assert.equal(senderRampDays({}, 'gw1', now), null);
  assert.equal(senderRampDays(null, 'gw1', now), null);
  assert.equal(senderRampDays({ gw1: 'garbage' }, 'gw1', now), null); // bad date → null, never NaN
  // Clock skew (anchor in the future) clamps to 0, never negative.
  assert.equal(senderRampDays({ gw1: new Date('2026-07-07T12:00:00Z') }, 'gw1', now), 0);
});

test('per-inbox ramp: a NEW inbox added to an old pool starts at 10/day, not full cap', () => {
  const now = new Date('2026-07-06T12:00:00Z');
  const anchors = { gw1: new Date('2026-04-01T12:00:00Z') }; // gw1 is ~13 weeks old
  // The old inbox is fully ramped…
  assert.equal(rampCap(senderRampDays(anchors, 'gw1', now), 40), 40);
  // …the new inbox is unanchored → callers treat null as day 0 → week-one pace.
  assert.equal(rampCap(senderRampDays(anchors, 'gw2', now) ?? 0, 40), 10);
});

// ── Send window (business timezone, DST-proof) ───────────────────────────────
// July = EDT (UTC-4); January = EST (UTC-5). The window is Mon–Fri 9a–5p ET.
test('send window opens 9am ET and closes 5pm ET (summer/EDT)', () => {
  assert.equal(isWithinSendWindow(new Date('2026-07-07T12:59:00Z')), false); // Tue 8:59a
  assert.equal(isWithinSendWindow(new Date('2026-07-07T13:00:00Z')), true);  // Tue 9:00a
  assert.equal(isWithinSendWindow(new Date('2026-07-07T20:59:00Z')), true);  // Tue 4:59p
  assert.equal(isWithinSendWindow(new Date('2026-07-07T21:00:00Z')), false); // Tue 5:00p
});

test('send window respects EST in winter', () => {
  assert.equal(isWithinSendWindow(new Date('2026-01-12T13:59:00Z')), false); // Mon 8:59a EST
  assert.equal(isWithinSendWindow(new Date('2026-01-12T14:00:00Z')), true);  // Mon 9:00a EST
});

test('send window is closed on weekends', () => {
  assert.equal(isWithinSendWindow(new Date('2026-07-11T15:00:00Z')), false); // Sat
  assert.equal(isWithinSendWindow(new Date('2026-07-12T15:00:00Z')), false); // Sun
  assert.equal(isWithinSendWindow(new Date('2026-07-13T15:00:00Z')), true);  // Mon 11a EDT
});

// ── Merge templates ──────────────────────────────────────────────────────────
test('renderTemplate fills fields, honors |fallbacks, blanks unknowns', () => {
  const ctx = { firstName: 'Sam', companyName: 'Green Leaf', city: '' };
  assert.equal(renderTemplate('Hey {{firstName}},', ctx), 'Hey Sam,');
  assert.equal(renderTemplate('Hey {{firstName|there}},', {}), 'Hey there,');
  assert.equal(renderTemplate('in {{city|your area}}', ctx), 'in your area');
  assert.equal(renderTemplate('{{ companyName }} rocks', ctx), 'Green Leaf rocks');
  assert.equal(renderTemplate('{{nonsense}}!', ctx), '!');
  assert.equal(renderTemplate('no tokens here', ctx), 'no tokens here');
  assert.equal(renderTemplate('', ctx), '');
  assert.equal(renderTemplate(null, ctx), '');
});

test('buildMergeContext derives firstName and falls back through contacts', () => {
  const c = buildMergeContext({
    companyName: 'Green Leaf Dispensary',
    clientName: 'Samantha Cole',
    address: '12 High St, Trenton NJ 08601',
  });
  assert.equal(c.companyName, 'Green Leaf Dispensary');
  assert.equal(c.firstName, 'Samantha');
  assert.equal(c.city, 'Trenton');
  assert.equal(c.state, 'NJ');           // {{state}} parsed from the address
  assert.equal(c.senderName, 'Nate');    // default when OUTREACH_SENDER_NAME unset

  const viaContact = buildMergeContext({
    companyName: 'Green Leaf',
    contacts: [{ name: 'Bob Ray', email: 'b@x.com' }],
  });
  assert.equal(viaContact.firstName, 'Bob');

  const empty = buildMergeContext({});
  assert.equal(empty.firstName, '');
  assert.equal(empty.companyName, '');
});

test('greeting: "Hey Sam," with a name, plain "Hey," without — never "Hey ,"', () => {
  assert.equal(buildMergeContext({ clientName: 'Sam Rivera' }).greeting, 'Hey Sam,');
  assert.equal(buildMergeContext({ contacts: [{ name: 'Bob Ray' }] }).greeting, 'Hey Bob,');
  assert.equal(buildMergeContext({ companyName: 'Green Leaf' }).greeting, 'Hey,');
  assert.equal(buildMergeContext({}).greeting, 'Hey,');
  // Rendered through a template, the no-name case is clean.
  assert.equal(renderTemplate('{{greeting}} quick question…', buildMergeContext({})), 'Hey, quick question…');
});

test('cityFromAddress handles the common address shapes', () => {
  assert.equal(cityFromAddress('123 Main St, Newark NJ 07102'), 'Newark');
  assert.equal(cityFromAddress('123 Main St, Newark, NJ 07102'), 'Newark');
  assert.equal(cityFromAddress('123 Main St, Egg Harbor Township NJ 08234'), 'Egg Harbor Township');
  assert.equal(cityFromAddress('1 Elm St, 2nd Floor, Newark NJ 07102'), 'Newark');
  assert.equal(cityFromAddress('Newark'), '');       // no comma → can't tell
  assert.equal(cityFromAddress(''), '');
  assert.equal(cityFromAddress(null), '');
});

// ── Message composition (CAN-SPAM) ───────────────────────────────────────────
test('composeMessage footer is a bare Unsubscribe with NO postal address', () => {
  const { html, text } = composeMessage({ bodyText: 'Hi there.\n\nSecond para.', token: 'tok123' });
  // Opt-out present in both parts.
  assert.match(html, /[Uu]nsubscribe/);
  assert.match(text, /[Uu]nsubscribe/i);
  // Owner's call: no street / postal line leaks into the footer. (The SIGNATURE
  // legitimately says "Joint Printing · jointprinting.com" — that's the sign-off,
  // not an address — so only address-shaped strings are asserted absent.)
  assert.doesNotMatch(html, /Elliot|Voorhees|NJ 0804/i);
  assert.doesNotMatch(text, /Elliot|Voorhees|NJ 0804/i);
  // Two paragraphs render as two <p> blocks, plus the footer <p>.
  assert.equal((html.match(/<p /g) || []).length >= 3, true); // 2 body + footer
});

test('bodyToHtml escapes HTML so a template can never inject markup', () => {
  const html = bodyToHtml('Deal: <b>50% off</b> & more\nline two');
  assert.match(html, /&lt;b&gt;50% off&lt;\/b&gt; &amp; more/);
  assert.match(html, /<br>line two/);
});

// ── Live-send guards ─────────────────────────────────────────────────────────
test('sendBlockReason blocks archived / opted-out / closed / customer, allows leads', () => {
  assert.equal(sendBlockReason(null), 'archived');
  assert.equal(sendBlockReason({ archived: true }), 'archived');
  assert.equal(sendBlockReason({ doNotEmail: true }), 'do-not-email');
  assert.equal(sendBlockReason({ stage: 'lost' }), 'closed-stage');
  assert.equal(sendBlockReason({ stage: 'dormant' }), 'closed-stage');
  assert.equal(sendBlockReason({ stage: 'won' }), 'became-customer');
  assert.equal(sendBlockReason({ stage: 'customer' }), 'became-customer');
  assert.equal(sendBlockReason({ stage: 'lead' }), '');
  assert.equal(sendBlockReason({ stage: 'contacted' }), '');
  assert.equal(sendBlockReason({}), '');              // default stage = lead
});

test('pickEmail prefers the company email, falls back to the first contact with one', () => {
  assert.equal(pickEmail({ email: 'a@x.com' }), 'a@x.com');
  assert.equal(pickEmail({ email: ' ', contacts: [{ email: '' }, { email: 'c@x.com' }] }), 'c@x.com');
  assert.equal(pickEmail({ contacts: [] }), '');
  assert.equal(pickEmail({}), '');
});

// ── Permanent vs temporary SMTP failure ──────────────────────────────────────
test('isPermanentSmtpError: 5xx / bad-mailbox = permanent (suppress)', () => {
  assert.equal(isPermanentSmtpError({ responseCode: 550, message: 'No such user' }), true);
  assert.equal(isPermanentSmtpError({ responseCode: 553, message: 'mailbox unavailable' }), true);
  assert.equal(isPermanentSmtpError({ message: '5.1.1 recipient rejected' }), true);
  assert.equal(isPermanentSmtpError({ message: 'User unknown in virtual mailbox table' }), true);
  assert.equal(isPermanentSmtpError({ message: 'Recipient address rejected: does not exist' }), true);
});

test('isPermanentSmtpError: temporary / unknown = NOT permanent (retry)', () => {
  assert.equal(isPermanentSmtpError({ responseCode: 451, message: 'greylisted, try later' }), false);
  assert.equal(isPermanentSmtpError({ responseCode: 421, message: 'service unavailable' }), false);
  assert.equal(isPermanentSmtpError({ code: 'ETIMEDOUT', message: 'connection timed out' }), false);
  assert.equal(isPermanentSmtpError({ message: 'socket hang up' }), false);
  assert.equal(isPermanentSmtpError(null), false);
  assert.equal(isPermanentSmtpError({}), false);
});

test('isBadRecipientError: genuine dead-mailbox rejections → true (safe to suppress)', () => {
  assert.equal(isBadRecipientError({ responseCode: 550, message: 'No such user' }), true);
  assert.equal(isBadRecipientError({ message: '550 5.1.1 recipient rejected' }), true);
  assert.equal(isBadRecipientError({ responseCode: 550, message: 'mailbox unavailable' }), true);
  assert.equal(isBadRecipientError({ message: 'User unknown in virtual mailbox table' }), true);
  assert.equal(isBadRecipientError({ message: 'Recipient address rejected: does not exist' }), true);
  // A bare 550 with no sender-side keyword defaults to "mailbox unavailable".
  assert.equal(isBadRecipientError({ responseCode: 550, message: 'requested action not taken' }), true);
});

test('isBadRecipientError: SENDER-side / transient 5xx → FALSE (never poison the lead)', () => {
  // THE BUG: these used to be treated as dead recipients and suppress + doNotEmail
  // every lead when the sender was misconfigured. They must NOT suppress now.
  assert.equal(isBadRecipientError({ responseCode: 550, message: 'Sender address rejected: not verified' }), false);
  assert.equal(isBadRecipientError({ responseCode: 550, message: 'Relay access denied' }), false);
  assert.equal(isBadRecipientError({ responseCode: 535, message: 'Authentication failed' }), false);
  assert.equal(isBadRecipientError({ message: '5.7.1 not authorized' }), false);
  assert.equal(isBadRecipientError({ responseCode: 554, message: 'blocked using Spamhaus' }), false);
  assert.equal(isBadRecipientError({ responseCode: 552, message: 'mailbox quota exceeded' }), false);
  // Transient / connection — also never suppress.
  assert.equal(isBadRecipientError({ responseCode: 421, message: 'service unavailable, try again' }), false);
  assert.equal(isBadRecipientError({ code: 'ETIMEDOUT', message: 'connection timed out' }), false);
  assert.equal(isBadRecipientError(null), false);
  assert.equal(isBadRecipientError({}), false);
});

// ── Wave 3: engine hardening (pacing / backoff / idempotency) ─────────────────
test('transientBackoffMs grows 30m → 2h → 6h and then holds', () => {
  assert.equal(transientBackoffMs(1), 30 * 60 * 1000);
  assert.equal(transientBackoffMs(2), 2 * 60 * 60 * 1000);
  assert.equal(transientBackoffMs(3), 6 * 60 * 60 * 1000);
  assert.equal(transientBackoffMs(4), 6 * 60 * 60 * 1000); // clamped
  assert.equal(transientBackoffMs(0), 30 * 60 * 1000);     // floored
});

test('jitteredFollowUpAt lands offsetDays out, jittered within ±3h of the target', () => {
  const base = new Date('2026-07-03T14:00:00Z');
  const target = base.getTime() + 3 * 86400000;
  const mid = jitteredFollowUpAt(base, 3, 0.5).getTime();   // rand .5 → no jitter
  assert.equal(mid, target);
  const lo = jitteredFollowUpAt(base, 3, 0).getTime();      // rand 0 → -3h
  const hi = jitteredFollowUpAt(base, 3, 1).getTime();      // rand 1 → +3h
  assert.equal(lo, target - 3 * 60 * 60 * 1000);
  assert.equal(hi, target + 3 * 60 * 60 * 1000);
  // Never schedules in under a day, even with offset 0 and full negative jitter.
  assert.ok(jitteredFollowUpAt(base, 0, 0).getTime() >= base.getTime() + 86400000 - 3 * 60 * 60 * 1000);
});

test('variableBatch varies around the base but never below 1', () => {
  assert.equal(variableBatch(5, 0), 4);      // -1
  assert.equal(variableBatch(5, 0.5), 6);    // +1
  assert.equal(variableBatch(5, 0.99), 7);   // +2
  assert.equal(variableBatch(1, 0), 1);      // floored at 1
});

test('outreachMessageId is stable per (enrollment, step) for provider dedupe', () => {
  const enr = { _id: 'abc123' };
  const a = outreachMessageId(enr, 0);
  const b = outreachMessageId(enr, 0);
  const c = outreachMessageId(enr, 1);
  assert.equal(a, b);          // same step → identical id (a retry dedupes)
  assert.notEqual(a, c);       // next step → different id
  assert.match(a, /^<outreach-abc123-0@.+>$/);
});

// ── Wave 5b: decision-maker targeting ─────────────────────────────────────────
test('isRoleEmail flags shared aliases, not named people', () => {
  const { isRoleEmail } = require('../outreachEngine');
  assert.ok(isRoleEmail('info@shop.com'));
  assert.ok(isRoleEmail('sales.team@shop.com'));
  assert.ok(isRoleEmail('orders+nj@shop.com'));
  assert.ok(!isRoleEmail('jane@shop.com'));
  assert.ok(!isRoleEmail('john.smith@shop.com'));
});

test('pickEmail prefers a named person over a role inbox', () => {
  // role top-level email, but a named contact exists → pick the person
  assert.equal(pickEmail({ email: 'info@shop.com', contacts: [{ email: 'jane@shop.com', name: 'Jane Doe' }] }), 'jane@shop.com');
  // only a role inbox → still return it (better than nothing)
  assert.equal(pickEmail({ email: 'info@shop.com' }), 'info@shop.com');
  // a non-role top-level email wins over an unnamed contact
  assert.equal(pickEmail({ email: 'owner@shop.com', contacts: [{ email: 'x@shop.com' }] }), 'owner@shop.com');
  assert.equal(pickEmail({}), '');
});

// ── Subject A/B arm assignment ───────────────────────────────────────────────
const { abVariant } = require('../outreachEngine');

test('abVariant: stable per token, and both arms occur across tokens', () => {
  const arms = new Set();
  for (let i = 0; i < 40; i++) {
    const tok = `token-${i}`;
    const v = abVariant(tok);
    assert.equal(v, abVariant(tok)); // same token → same arm, always
    assert.ok(v === 'A' || v === 'B');
    arms.add(v);
  }
  assert.equal(arms.size, 2); // a 40-token sample hits both arms
});

// ── Sender signature (body → sig → footer ordering) ───────────────────────────
const { buildSignature } = require('../outreachEngine');
test('buildSignature: default sig, env override, and never double-signs', () => {
  // Default (no env): Nate + the shop line.
  const def = buildSignature('Quick question about your shop.', '', 'Joint Printing');
  assert.deepEqual(def, ['Nate', 'Joint Printing · jointprinting.com']);
  // Env override wins; literal "\n" and real newlines both split lines.
  assert.deepEqual(buildSignature('Hi.', 'Nate\\nJoint Printing\\njointprinting.com'), ['Nate', 'Joint Printing', 'jointprinting.com']);
  assert.deepEqual(buildSignature('Hi.', 'Nate\nThe Print Guy'), ['Nate', 'The Print Guy']);
  // Body already carries the site link (owner wrote a sign-off) → no signature.
  assert.equal(buildSignature('…check us out at jointprinting.com\n— Nate', '', ''), null);
});

test('composeMessage places the signature between body and footer in BOTH parts', () => {
  const { html, text } = composeMessage({ bodyText: 'Hi there.\n\nSecond para.', token: 'tok123' });
  // Signature present…
  assert.match(html, /Nate/);
  assert.match(text, /\nNate\n/);
  // …linked site in the HTML part…
  assert.match(html, /href="https:\/\/jointprinting\.com"/);
  // …and ordered body → signature → opt-out footer (footer casing varies by
  // link-vs-reply mode, so match case-insensitively).
  const lower = text.toLowerCase();
  assert.ok(text.indexOf('Second para.') < text.indexOf('Nate'));
  assert.ok(lower.indexOf('nate') < lower.indexOf('unsubscribe'));
  // A body that signed itself gets no injected signature block.
  const own = composeMessage({ bodyText: 'See jointprinting.com — Nate', token: 'tok9' });
  assert.equal(/(^|\n)Nate\n/.test(own.text.replace('— Nate', '')), false);
});

// ── Auto roster hygiene (bounce-spike re-verification) ────────────────────────
const { campaignBounceSignal, shouldRunHygiene, pickInvalidEnrollments } = require('../outreachEngine');

test('campaignBounceSignal counts sent + real bounces, not hygiene-prevented ones', () => {
  const rows = [
    { status: 'active', sends: [{ at: new Date() }] },                        // sent, fine
    { status: 'failed', stopReason: 'invalid-address', sends: [] },           // touch-1 SMTP bounce
    { status: 'failed', stopReason: 'bounced', sends: [{ at: new Date() }] }, // webhook hard bounce
    { status: 'failed', stopReason: 'complaint', sends: [{ at: new Date() }] }, // spam complaint
    { status: 'stopped', stopReason: 'invalid-address', sends: [] },          // hygiene drop — a bounce PREVENTED
    { status: 'active', sends: [] },                                          // still waiting
    null,                                                                     // garbage row ignored
  ];
  assert.deepEqual(campaignBounceSignal(rows), { sent: 3, bounced: 3 });
  assert.deepEqual(campaignBounceSignal([]), { sent: 0, bounced: 0 });
  assert.deepEqual(campaignBounceSignal(), { sent: 0, bounced: 0 });
});

test('shouldRunHygiene trips only on a real spike (≥2 bounced AND ≥5% of ≥10 sent)', () => {
  assert.equal(shouldRunHygiene({ sent: 20, bounced: 2 }), true);    // the owner's exact card: 2 of 20
  assert.equal(shouldRunHygiene({ sent: 9, bounced: 3 }), false);    // sample too small
  assert.equal(shouldRunHygiene({ sent: 40, bounced: 1 }), false);   // one fluke isn't a spike
  assert.equal(shouldRunHygiene({ sent: 100, bounced: 4 }), false);  // 4% — under the rate bar
  assert.equal(shouldRunHygiene({ sent: 100, bounced: 5 }), true);   // exactly 5% trips
  assert.equal(shouldRunHygiene({ sent: 0, bounced: 0 }), false);
  assert.equal(shouldRunHygiene({}), false);
  assert.equal(shouldRunHygiene(), false);
});

test('shouldRunHygiene runs at most once per campaign per 24h', () => {
  const now = new Date('2026-07-07T12:00:00Z');
  const spike = { sent: 20, bounced: 2 };
  assert.equal(shouldRunHygiene(spike, null, now), true);                              // never ran
  assert.equal(shouldRunHygiene(spike, new Date('2026-07-07T02:00:00Z'), now), false); // 10h ago — fresh
  assert.equal(shouldRunHygiene(spike, new Date('2026-07-06T11:00:00Z'), now), true);  // 25h ago — stale
  assert.equal(shouldRunHygiene(spike, 'not-a-date', now), true);                      // garbage stamp ≈ never ran
});

test('pickInvalidEnrollments drops only DEFINITIVE dead-MX domains (fail-open otherwise)', () => {
  const rows = [
    { toEmail: 'a@dead.com' },
    { toEmail: 'B@Dead.com' },   // domain match is case-insensitive
    { toEmail: 'c@alive.com' },  // domain verified fine → keep
    { toEmail: 'd@unknown.com' },// never checked / transient DNS → fail-open, keep
    { toEmail: '' },             // no address → nothing to verify
    null,
  ];
  const mx = new Map([['dead.com', false], ['alive.com', true]]);
  assert.deepEqual(pickInvalidEnrollments(rows, mx).map((e) => e.toEmail), ['a@dead.com', 'B@Dead.com']);
  assert.deepEqual(pickInvalidEnrollments([], mx), []);
  assert.deepEqual(pickInvalidEnrollments(), []);
});

test('looksLikeDnsOutage: a mostly-dead verdict on a real sample is a resolver problem', () => {
  const { looksLikeDnsOutage } = require('../outreachEngine');
  assert.equal(looksLikeDnsOutage(50, 50), true);   // everything "dead" at once
  assert.equal(looksLikeDnsOutage(6, 10), true);    // >half of a real sample
  assert.equal(looksLikeDnsOutage(5, 10), false);   // exactly half — plausible rot
  assert.equal(looksLikeDnsOutage(4, 4), false);    // tiny sample — believable, drop them
  assert.equal(looksLikeDnsOutage(2, 3), false);    // small absolute count
  assert.equal(looksLikeDnsOutage(0, 0), false);
});

// ── Deliverability circuit-breaker: min-sample + absolute-count floors ─────────
// Regression: a small batch (3 bounces on 30 sends = 10%) must NOT trip the breaker
// — a rate over a tiny sample is noise, and pausing then FREEZES the engine (it
// can't dilute the rate with fresh good sends). The breaker requires a real sample
// AND an absolute count of bad events, not just a rate.
const { evaluateDeliverability } = require('../outreachEngine');

test('breaker: 3 bounces on 30 sends (10%) does NOT trip — sample too small', () => {
  const r = evaluateDeliverability({ sent7d: 30, bounced7d: 3, complaints7d: 0 });
  assert.equal(r.tripped, false);
  assert.equal(r.reason, '');
});

test('breaker: 3 bounces on 60 sends (5%) does NOT trip — bounce count under the floor', () => {
  // 60 sends clears the sample floor, but 3 bounces is still noise (< min-bounces).
  const r = evaluateDeliverability({ sent7d: 60, bounced7d: 3, complaints7d: 0 });
  assert.equal(r.tripped, false);
});

test('breaker: 8 bounces on 80 sends (10%) DOES trip — real sample + real count', () => {
  const r = evaluateDeliverability({ sent7d: 80, bounced7d: 8, complaints7d: 0 });
  assert.equal(r.tripped, true);
  assert.match(r.reason, /bounce rate/);
});

test('breaker: healthy volume (6 bounces on 400 sends = 1.5%) does NOT trip', () => {
  const r = evaluateDeliverability({ sent7d: 400, bounced7d: 6, complaints7d: 0 });
  assert.equal(r.tripped, false);
});

test('breaker: 1 complaint on 60 sends does NOT trip — complaint count under the floor', () => {
  const r = evaluateDeliverability({ sent7d: 60, bounced7d: 0, complaints7d: 1 });
  assert.equal(r.tripped, false);
});

test('breaker: no sends → not tripped, zero rates', () => {
  const r = evaluateDeliverability({ sent7d: 0, bounced7d: 0, complaints7d: 0 });
  assert.equal(r.tripped, false);
  assert.equal(r.bounceRate, 0);
});
