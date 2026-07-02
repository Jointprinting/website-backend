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
} = require('../outreachEngine');

// ── Warm-up ramp ─────────────────────────────────────────────────────────────
test('rampCap climbs 10/week and tops out at the max cap', () => {
  assert.equal(rampCap(0, 40), 10);   // day 1 — week one
  assert.equal(rampCap(6, 40), 10);   // still week one
  assert.equal(rampCap(7, 40), 20);   // week two
  assert.equal(rampCap(13, 40), 20);
  assert.equal(rampCap(14, 40), 30);  // week three
  assert.equal(rampCap(21, 40), 40);  // week four = max
  assert.equal(rampCap(70, 40), 40);  // never exceeds max
});

test('rampCap: no first send yet (or garbage) → week-one pace; low max wins', () => {
  assert.equal(rampCap(null, 40), 10);
  assert.equal(rampCap(undefined, 40), 10);
  assert.equal(rampCap(-3, 40), 10);
  assert.equal(rampCap(NaN, 40), 10);
  assert.equal(rampCap(21, 25), 25);  // owner-configured lower ceiling
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

  const viaContact = buildMergeContext({
    companyName: 'Green Leaf',
    contacts: [{ name: 'Bob Ray', email: 'b@x.com' }],
  });
  assert.equal(viaContact.firstName, 'Bob');

  const empty = buildMergeContext({});
  assert.equal(empty.firstName, '');
  assert.equal(empty.companyName, '');
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
