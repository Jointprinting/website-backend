// controllers/__tests__/ownReplyCloses.test.js
//
// "when someone first replies i should be notified until i do something about
// it, but subsequent emails shouldn't clog my signals cause i'm obviously
// already talking to them."
//
// The loop could not see the owner ANSWER — every folder it reads excludes his
// own outbound — so a worklist row had no way to stop asking except him going
// and clicking it closed. closeOnOwnReply is the other half of the
// conversation: the ball is in whoever's court spoke last.
//
//   node --test controllers/__tests__/ownReplyCloses.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const TriageReply = require('../../models/TriageReply');
const OutreachEnrollment = require('../../models/OutreachEnrollment');
const Client = require('../../models/Client');
const { closeOnOwnReply } = require('../replyTriage');

const THEIR_SEND = '<send-abc@jointprintingshop.com>';

// One enrolled shop, reachable by address AND by thread — the two strong matches.
function stubEnrollments(t, rows) {
  t.mock.method(OutreachEnrollment, 'find', () => ({
    select: () => ({ limit: () => ({ lean: async () => rows }) }),
  }));
}
function stubClients(t, rows = []) {
  t.mock.method(Client, 'find', () => ({ select: () => ({ lean: async () => rows }) }));
}
// Capture what the closer would write, and report a plausible modifiedCount.
function captureUpdates(t, modified = 1) {
  const calls = [];
  t.mock.method(TriageReply, 'updateMany', async (filter, update) => {
    calls.push({ filter, update });
    return { modifiedCount: modified };
  });
  return calls;
}

const ENROLLED = [{
  _id: 'e1', companyKey: 'apothecare-ann-arbor', companyName: 'Apothecare Ann Arbor',
  toEmail: 'buyer@apothecare.com',
  sends: [{ messageId: THEIR_SEND, subject: 'Custom Merch/Apparel for Apothecare Ann Arbor' }],
}];

test('answering a buyer in Gmail takes their row off the worklist', async (t) => {
  stubEnrollments(t, ENROLLED);
  stubClients(t);
  const calls = captureUpdates(t, 1);

  const closed = await closeOnOwnReply({
    toEmails: ['buyer@apothecare.com'],
    subject: 'Re: Custom Merch/Apparel for Apothecare Ann Arbor',
    messageIds: [THEIR_SEND],
    sentAt: new Date('2026-08-13T15:00:00Z'),
  });

  assert.equal(closed, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filter.companyKey, 'apothecare-ann-arbor');
  assert.equal(calls[0].update.$set.status, 'handled');
  assert.equal(calls[0].update.$set.handledBy, 'owner-reply');
});

test('only the rows still waiting on him are closed', async (t) => {
  stubEnrollments(t, ENROLLED);
  stubClients(t);
  const calls = captureUpdates(t);

  await closeOnOwnReply({
    toEmails: ['buyer@apothecare.com'], subject: 'Re: hi', messageIds: [THEIR_SEND],
    sentAt: new Date('2026-08-13T15:00:00Z'),
  });

  // 'new' only. quote_requested / mockup_requested / follow_up are states HE set
  // to track his own work — sending a message doesn't deliver a quote.
  assert.equal(calls[0].filter.status, 'new');
});

test('a message that arrived AFTER his answer survives', async (t) => {
  stubEnrollments(t, ENROLLED);
  stubClients(t);
  const calls = captureUpdates(t);

  const sentAt = new Date('2026-08-13T15:00:00Z');
  await closeOnOwnReply({
    toEmails: ['buyer@apothecare.com'], subject: 'Re: hi', messageIds: [THEIR_SEND], sentAt,
  });

  // This is the whole safety property. Without it, a buyer who writes back two
  // minutes after his reply is silently marked handled and never surfaces.
  assert.deepEqual(calls[0].filter.receivedAt, { $lt: sentAt });
});

test('a soft DOMAIN match never silences a buying signal', async (t) => {
  // Same business domain, different mailbox — good enough to show a link, not
  // good enough to close a row. The auto-actions hold to the same bar.
  stubEnrollments(t, [{
    _id: 'e2', companyKey: 'someshop', companyName: 'Some Shop',
    toEmail: 'info@someshop.com', sends: [],
  }]);
  stubClients(t);
  const calls = captureUpdates(t);

  const closed = await closeOnOwnReply({
    toEmails: ['different.person@someshop.com'],   // domain-only match
    subject: 'a subject we never sent',
    messageIds: [],
    sentAt: new Date('2026-08-13T15:00:00Z'),
  });

  assert.equal(closed, 0);
  assert.equal(calls.length, 0, 'a domain match must not close anything');
});

test('mail to someone we have no lead for closes nothing', async (t) => {
  stubEnrollments(t, []);
  stubClients(t);
  const calls = captureUpdates(t);

  const closed = await closeOnOwnReply({
    toEmails: ['accountant@example.com'], subject: 'invoice', messageIds: [],
    sentAt: new Date('2026-08-13T15:00:00Z'),
  });

  assert.equal(closed, 0);
  assert.equal(calls.length, 0);
});

test('one sent message closes a company once, however many recipients', async (t) => {
  stubEnrollments(t, ENROLLED);
  stubClients(t);
  const calls = captureUpdates(t, 1);

  // He replied to the buyer and cc'd a second address at the same shop.
  const closed = await closeOnOwnReply({
    toEmails: ['buyer@apothecare.com', 'buyer@apothecare.com'],
    subject: 'Re: hi', messageIds: [THEIR_SEND],
    sentAt: new Date('2026-08-13T15:00:00Z'),
  });

  assert.equal(calls.length, 1, 'same company, one close');
  assert.equal(closed, 1);
});

test('a sent message with no recipients and no thread is a no-op', async (t) => {
  const calls = captureUpdates(t);
  assert.equal(await closeOnOwnReply({ subject: 'draft', sentAt: new Date() }), 0);
  assert.equal(await closeOnOwnReply({}), 0);
  assert.equal(calls.length, 0);
});

test('an unparseable sent date never closes anything', async (t) => {
  const calls = captureUpdates(t);
  const closed = await closeOnOwnReply({
    toEmails: ['buyer@apothecare.com'], subject: 'Re: hi', sentAt: 'not-a-date',
  });
  // An Invalid Date in the receivedAt guard would compare false for every row —
  // silently closing nothing is fine, silently closing EVERYTHING would not be.
  assert.equal(closed, 0);
  assert.equal(calls.length, 0);
});

// ── The reader side ──────────────────────────────────────────────────────────

test('the Sent scan is envelope-only, so it cannot eat the body budget', () => {
  const src = require('fs').readFileSync(require.resolve('../../services/replyImap'), 'utf8');
  const fn = src.match(/async function fetchSentFolder[\s\S]*?\n}\n/);
  assert.ok(fn, 'fetchSentFolder not found');
  assert.match(fn[0], /envelope: true/);
  // A body fetch here would spend MAX_BODIES_PER_RUN on mail we already wrote,
  // starving the actual replies — the exact failure the budget exists to stop.
  assert.doesNotMatch(fn[0], /bodyStructure|source|BODY\[/,
    'the Sent pass must never download bodies');
  assert.doesNotMatch(fn[0], /stats\.bodies/);
});

test('the Sent scan matches on the thread it answers, not its own id', () => {
  const src = require('fs').readFileSync(require.resolve('../../services/replyImap'), 'utf8');
  const fn = src.match(/async function fetchSentFolder[\s\S]*?\n}\n/);
  // env.messageId is OURS. Passing it would resolve every sent message to the
  // send it is, matching the company on nothing at all.
  assert.match(fn[0], /inReplyTo/);
  assert.doesNotMatch(fn[0], /messageIds: \[env\.messageId/);
});

test('only the first Sent folder that exists is scanned', () => {
  const src = require('fs').readFileSync(require.resolve('../../services/replyImap'), 'utf8');
  // Gmail exposes the same message under more than one name; closing the same
  // conversation twice is wasted work.
  assert.match(src, /for \(const name of SENT_FOLDERS\) \{\s*if \(await fetchSentFolder\([^)]*\)\) break;/);
});
