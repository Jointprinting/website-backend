// controllers/__tests__/engagedConversation.test.js
//
// "ive been messaging apothecare and it keeps adding needs a reply into my
// signals, once i mark a conversation once i shouldnt have to do it again."
//
// He asked for this twice. The first build answered a different question
// (ball-in-whoever-spoke-last), which re-opens the row on every inbound message
// — so a 34-message live deal generated 34 signals.
//
//   node --test controllers/__tests__/engagedConversation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { STATUSES } = require('../../services/replyTriage');
const { worklistFromReplies } = require('../../services/replyTriage');
const { threadIdsFrom } = require('../../services/replyImap');

// ── The status ───────────────────────────────────────────────────────────────

test('in_conversation is a real status', () => {
  assert.ok(STATUSES.includes('in_conversation'));
});

test('an in-conversation reply is in no signal feed', () => {
  // Chosen as a STATUS rather than a flag precisely so this holds everywhere at
  // once: the worklist, the hub's Smart Alerts and hubPulse's raw
  // countDocuments each independently test `status === 'new'`.
  const rows = [
    { _id: '1', status: 'in_conversation', category: 'asked_pricing', companyKey: 'apothecare', receivedAt: new Date() },
    { _id: '2', status: 'new', category: 'asked_pricing', companyKey: 'freshshop', receivedAt: new Date() },
  ];
  const b = worklistFromReplies(rows);
  assert.equal(b.needsResponse.length, 1);
  assert.equal(b.needsResponse[0].companyKey, 'freshshop');
});

test('every signal feed still keys on status new', () => {
  // If any of them ever stops testing 'new', in_conversation silently starts
  // showing up there again. Pin the coupling this design depends on.
  const fs = require('fs');
  const signals = fs.readFileSync(require.resolve('../../services/signals'), 'utf8');
  assert.match(signals, /status !== 'new'/);
  assert.match(signals, /status: 'new'/);
  const triage = fs.readFileSync(require.resolve('../../services/replyTriage'), 'utf8');
  assert.match(triage, /r\.status === 'new' && ACTIONABLE_CATEGORIES/);
});

// ── The thread spine ─────────────────────────────────────────────────────────
// The previous suite passed while the closer was structurally dead, because it
// fed closeOnOwnReply a Message-ID the reader can never produce. This tests the
// READER's shaping against a realistic envelope instead.

test('the sent-message thread ids include the root the enrollment stores', () => {
  const ROOT = '<cold-send-root@jointprintingshop.com>';
  // An IMAP ENVELOPE has ten fields and `references` is NOT one of them —
  // imapflow does not synthesize it. Reading env.references gave undefined, so
  // messageIds collapsed to In-Reply-To alone, which on his 34th message is HER
  // message 33 — and the original cold send is the In-Reply-To of nothing he
  // ever sent. The thread rung could never fire.
  const env = { inReplyTo: '<her-msg-33@mail.gmail.com>' };
  const headers = Buffer.from(
    `References: ${ROOT} <r2@mail.gmail.com> <her-msg-33@mail.gmail.com>\r\n`
    + 'In-Reply-To: <her-msg-33@mail.gmail.com>\r\n',
  );
  const ids = threadIdsFrom(env, headers);
  assert.ok(ids.includes(ROOT), 'the root cold-send id must come back');
  // Envelope-only, the way it used to be read:
  const oldWay = [env.inReplyTo, ...(env.references || [])].filter(Boolean);
  assert.equal(oldWay.includes(ROOT), false, 'proves the old path could not work');
});

test('a sent message never matches itself', () => {
  const env = { inReplyTo: '<parent@x.com>', messageId: '<mine@jointprintingshop.com>' };
  const ids = threadIdsFrom(env, Buffer.from('References: <parent@x.com>\r\n'));
  assert.equal(ids.includes('<mine@jointprintingshop.com>'), false);
});

test('threadIdsFrom survives a message with no headers at all', () => {
  assert.deepEqual(threadIdsFrom({}, null), []);
  assert.deepEqual(threadIdsFrom({ inReplyTo: '<a@b.c>' }, null), ['<a@b.c>']);
});

// ── The rules that protect revenue ───────────────────────────────────────────

test('the closer accepts a domain match only with corroboration', () => {
  const src = require('fs').readFileSync(require.resolve('../replyTriage'), 'utf8');
  const fn = src.match(/async function closeOnOwnReply[\s\S]*?\n}\n/);
  assert.ok(fn);
  // Cold mail goes to info@/hello@ and a named buyer picks it up, so domain is
  // often the ONLY rung that fires on his answer. Refusing it outright is what
  // discarded the close; accepting it blind would let a stranger on a shared
  // domain silence a real signal. Corroboration is the middle.
  assert.match(fn[0], /matchBy: \{ \$in: \[\.\.\.STRONG_MATCHES\] \}/);
});

test('engagement is set by HIS action, never hers', () => {
  const src = require('fs').readFileSync(require.resolve('../replyTriage'), 'utf8');
  // Every pre-existing "warm" marker (lastContact, stage, the warm tag,
  // enrollment 'replied') is written by warmCompany on the INBOUND message, so
  // any of them would silence the first-reply notification he asked to keep.
  for (const trigger of [/markEngaged\(reply\.companyKey, 'triage'\)/,
    /markEngaged\(match\.companyKey, 'owner-reply'\)/,
    /markEngaged\(reply\.companyKey, 'job'\)/]) {
    assert.match(src, trigger);
  }
  // ingestOne must never mark engagement — that is her message arriving.
  const ingest = src.match(/async function ingestOne[\s\S]*?\n}\n/);
  assert.ok(ingest);
  assert.doesNotMatch(ingest[0], /markEngaged/);
});

test('markEngaged is first-write-wins so silence can never be extended', () => {
  const src = require('fs').readFileSync(require.resolve('../replyTriage'), 'utf8');
  const fn = src.match(/async function markEngaged[\s\S]*?\n}\n/);
  assert.ok(fn);
  // Re-engaging must not move the clock forward: the quiet-gap rule measures
  // from the last thing that happened, and a moving engagedAt could hold a dead
  // relationship open indefinitely.
  assert.match(fn[0], /engagedAt: null/);
  assert.match(fn[0], /\$exists: false/);
});

test('the quiet-gap rule re-opens a conversation that went cold', () => {
  const src = require('fs').readFileSync(require.resolve('../replyTriage'), 'utf8');
  const fn = src.match(/async function statusForIncoming[\s\S]*?\n}\n/);
  assert.ok(fn);
  // This is the one thing standing between the feature and silencing a real
  // order: Apothecare goes quiet for two months, then writes "ready to order
  // 500 hoodies". That has to reach him.
  assert.match(fn[0], /QUIET_DAYS \* DAY_MS/);
  assert.match(fn[0], /return 'new'/);
  // Unmatched senders are always signals — we have no company to be engaged with.
  assert.match(fn[0], /if \(!key\) return 'new'/);
});

test('the backfill infers engagement only from what HE did', () => {
  const src = require('fs').readFileSync(require.resolve('../replyTriage'), 'utf8');
  const fn = src.match(/async function backfillEngagedConversations[\s\S]*?\n}\n/);
  assert.ok(fn);
  // warm / lastContact / stage / enrollment-'replied' are all written by
  // warmCompany on HER inbound message. Inferring from them would mark
  // companies engaged that he has never touched.
  for (const wrong of [/lastContact/, /'warm'/, /status: 'replied'/]) {
    assert.doesNotMatch(fn[0], wrong);
  }
  // It must move the existing rows too, or day one behaves like today.
  assert.match(fn[0], /status: 'new'/);
  assert.match(fn[0], /status: 'in_conversation'/);
});

test('the CRM Today queue is not re-armed for an engaged company', () => {
  const src = require('fs').readFileSync(require.resolve('../../services/warmHandoff'), 'utf8');
  // The dedupKey guard covered only the log LINE; nextFollowUp sat outside it,
  // so every one of Rebecca's messages also re-inserted Apothecare into the
  // Today call queue — the same nag through a second channel.
  assert.match(src, /if \(!client\.engagedAt\) \{\s*\n\s*client\.nextFollowUp/);
  // lastContact is genuinely per-message and must keep updating.
  assert.match(src, /client\.lastContact = now;/);
});
