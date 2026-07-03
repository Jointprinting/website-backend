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
  isWithinSendWindow,
  renderTemplate,
  buildMergeContext,
  cityFromAddress,
  composeMessage,
  sendBlockReason,
  bodyToHtml,
  pickEmail,
  isPermanentSmtpError,
  transientBackoffMs,
  jitteredFollowUpAt,
  variableBatch,
  outreachMessageId,
} = require('../outreachEngine');

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
test('composeMessage carries the postal address + an opt-out in html AND text', () => {
  const { html, text } = composeMessage({ bodyText: 'Hi there.\n\nSecond para.', token: 'tok123' });
  assert.match(html, /Joint Printing/);
  assert.match(text, /Joint Printing/);
  assert.match(html, /[Uu]nsubscribe/);
  assert.match(text, /[Uu]nsubscribe/i);
  // Two paragraphs render as two <p> blocks.
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
