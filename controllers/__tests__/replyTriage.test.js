// controllers/__tests__/replyTriage.test.js
//
// Gmail Reply Triage V1 — the classifier + matcher (services/replyTriage.js). Both
// are pure, so they're tested here without a DB or network, the way the rest of the
// suite works. These pin: (a) each of the nine categories fires on realistic buyer
// language, (b) precedence — kill-signals (self/auto/unsubscribe/not-interested)
// beat positive intent, and (c) a reply matches an existing lead by email first,
// subject as a fallback, and stays UNMATCHED (never dropped) when uncertain.
//
//   node --test controllers/__tests__/replyTriage.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CATEGORIES,
  STATUSES,
  classifyReply,
  classifyBounceNdr,
  matchReply,
  parseOooResume,
  suggestedActionFor,
  isValidStatus,
  isValidCategory,
  normSubject,
  worklistFromReplies,
} = require('../../services/replyTriage');

const cat = (fields) => classifyReply(fields).category;

// ── Enums ───────────────────────────────────────────────────────────────────────
test('enums expose the categories and the triage statuses', () => {
  assert.equal(CATEGORIES.length, 10);
  assert.ok(CATEGORIES.includes('hot_lead'));
  assert.ok(CATEGORIES.includes('auto_reply_ooo'));
  assert.ok(CATEGORIES.includes('bounce_auto_ignore'));
  assert.deepEqual(STATUSES, ['new', 'handled', 'follow_up', 'mockup_requested', 'quote_requested', 'not_interested', 'do_not_contact', 'ignored']);
  assert.ok(isValidStatus('do_not_contact'));
  assert.ok(!isValidStatus('nope'));
  assert.ok(isValidCategory('asked_pricing'));
  assert.ok(!isValidCategory('whatever'));
});

// ── Each category fires on realistic language ────────────────────────────────────
test('asked_pricing: buyer asks about cost / quote', () => {
  assert.equal(cat({ subject: 'Re: dispensary merch', snippet: 'What would pricing look like for 100 hoodies?' }), 'asked_pricing');
  assert.equal(cat({ snippet: 'Can you send a quote?' }), 'asked_pricing');
  assert.equal(cat({ snippet: "What's the cost per shirt at 250 units?" }), 'asked_pricing');
});

test('asked_mockups: buyer asks for a mockup / proof / design', () => {
  assert.equal(cat({ snippet: 'Could you put together a mockup with our logo?' }), 'asked_mockups');
  assert.equal(cat({ snippet: 'Send over a proof and we can go from there.' }), 'asked_mockups');
});

test('hot_lead: strong buying intent without a price/mockup ask', () => {
  assert.equal(cat({ snippet: "Yes, interested! Let's set up a call this week." }), 'hot_lead');
  assert.equal(cat({ snippet: 'We are ready to order shirts for our grand opening.' }), 'hot_lead');
  assert.equal(cat({ snippet: 'Give me a call, we want to move forward.' }), 'hot_lead');
});

test('follow_up_later: interested but not now', () => {
  assert.equal(cat({ snippet: 'Circle back next quarter — swamped right now.' }), 'follow_up_later');
  assert.equal(cat({ snippet: 'Reach back after the holidays please.' }), 'follow_up_later');
});

test('not_interested: a clear no', () => {
  assert.equal(cat({ snippet: "Not interested, thanks." }), 'not_interested');
  assert.equal(cat({ snippet: 'We already have a merch vendor.' }), 'not_interested');
  assert.equal(cat({ snippet: "We're all set for now." }), 'not_interested');
});

test('wrong_person: reply points elsewhere', () => {
  assert.equal(cat({ snippet: "You'll want to talk to our marketing manager instead." }), 'wrong_person');
  assert.equal(cat({ snippet: 'Please reach out to Dana, she handles purchasing.' }), 'wrong_person');
  assert.equal(cat({ snippet: "I'm no longer with the company." }), 'wrong_person');
});

test('unsubscribe: opt-out language', () => {
  assert.equal(cat({ snippet: 'Please unsubscribe me from this list.' }), 'unsubscribe');
  assert.equal(cat({ snippet: 'Take me off your emails.' }), 'unsubscribe');
  assert.equal(cat({ snippet: 'Do not contact me again.' }), 'unsubscribe');
});

test('bounce_auto_ignore: hard machine mail by sender or delivery-failure subject', () => {
  assert.equal(cat({ fromEmail: 'mailer-daemon@googlemail.com', subject: 'Delivery Status Notification (Failure)' }), 'bounce_auto_ignore');
  assert.equal(cat({ fromEmail: 'no-reply@news.example.com', subject: 'This week at Example' }), 'bounce_auto_ignore');
});

test('auto_reply_ooo: out-of-office auto-replies get their own category (snoozed, not ignored)', () => {
  const r = classifyReply({ fromEmail: 'sam@shop.com', subject: 'Automatic reply: Out of office' });
  assert.equal(r.category, 'auto_reply_ooo');
  assert.equal(r.ooo, true);
  assert.equal(r.ignore, false); // NOT dropped — the sequence should resume
  assert.equal(cat({ fromEmail: 'sam@shop.com', subject: 'Re: merch', snippet: 'I am currently out of the office until next week.' }), 'auto_reply_ooo');
  assert.equal(cat({ fromEmail: 'jo@shop.com', subject: 'Re: hi', snippet: 'This is an automated response — on vacation.' }), 'auto_reply_ooo');
});

test('parseOooResume: honors an explicit near-future M/D, else +7 days', () => {
  const now = new Date('2026-07-03T12:00:00Z');
  // explicit "back on 7/15" → that date
  const d = parseOooResume('I am out, back on 7/15.', now);
  assert.equal(d.getUTCMonth(), 6); // July (0-based)
  assert.equal(d.getUTCDate(), 15);
  // no date → default +7 days
  const def = parseOooResume('Out of office, limited access to email.', now);
  assert.equal(Math.round((def.getTime() - now.getTime()) / 86400000), 7);
  // an implausible far-out / past date is ignored → default +7
  const far = parseOooResume('back on 1/2', now); // already passed this year
  assert.equal(Math.round((far.getTime() - now.getTime()) / 86400000), 7);
});

test('needs_response: a genuine human reply with no clear signal', () => {
  assert.equal(cat({ subject: 'Re: hello', snippet: 'Thanks for reaching out, tell me more about what you do.' }), 'needs_response');
});

// ── Precedence: kill-signals beat positive intent ───────────────────────────────
test('unsubscribe wins even when the message also mentions price', () => {
  assert.equal(cat({ snippet: 'Unsubscribe me. (Also your pricing seemed high.)' }), 'unsubscribe');
});

test('not_interested wins over a stray "interested" phrasing', () => {
  assert.equal(cat({ snippet: 'Not interested — we already have a vendor.' }), 'not_interested');
});

test('own outbound mail is flagged self + ignore, never a real reply', () => {
  const r = classifyReply({ fromEmail: 'nate@jointprinting.com', snippet: 'Following up on my last note.' });
  assert.equal(r.self, true);
  assert.equal(r.ignore, true);
  assert.equal(r.category, 'bounce_auto_ignore');
});

// ── suggestedActionFor ──────────────────────────────────────────────────────────
test('suggestedActionFor returns a distinct hint per category, with a safe default', () => {
  assert.match(suggestedActionFor('asked_pricing'), /quote/i);
  assert.match(suggestedActionFor('asked_mockups'), /mockup/i);
  assert.match(suggestedActionFor('unsubscribe'), /do-not-email|do not email/i);
  assert.equal(suggestedActionFor('garbage'), suggestedActionFor('needs_response'));
});

// ── normSubject ─────────────────────────────────────────────────────────────────
test('normSubject strips Re:/Fwd: chains and lowercases', () => {
  assert.equal(normSubject('Re: Fwd: Custom Hoodies'), 'custom hoodies');
  assert.equal(normSubject('RE: RE: Quote'), 'quote');
  assert.equal(normSubject(''), '');
});

// ── matchReply ──────────────────────────────────────────────────────────────────
const ENR = [{ _id: 'e1', toEmail: 'Buyer@GreenLeaf.com', companyKey: 'greenleaf', companyName: 'Green Leaf', sends: [{ subject: 'Custom merch for Green Leaf' }] }];
const CLIENTS = [{ companyKey: 'highland', companyName: 'Highland Dispensary', email: 'orders@highland.com', contacts: [{ email: 'jess@highland.com' }] }];

test('matchReply: matches an enrollment by sender email (case-insensitive)', () => {
  const m = matchReply('buyer@greenleaf.com', 'Re: anything', { enrollments: ENR, clients: CLIENTS });
  assert.deepEqual(
    { matched: m.matched, by: m.matchBy, key: m.companyKey, enr: m.enrollmentId },
    { matched: true, by: 'email', key: 'greenleaf', enr: 'e1' },
  );
});

test('matchReply: matches a client by a contact email when no enrollment matches', () => {
  const m = matchReply('jess@highland.com', 'Re: hi', { enrollments: ENR, clients: CLIENTS });
  assert.equal(m.matched, true);
  assert.equal(m.matchBy, 'email');
  assert.equal(m.companyKey, 'highland');
  assert.equal(m.enrollmentId, ''); // client match carries no enrollment
});

test('matchReply: falls back to subject when the email is unknown', () => {
  const m = matchReply('someoneelse@gmail.com', 'Re: Custom merch for Green Leaf',
    { enrollments: ENR.map((e) => ({ ...e, subjects: e.sends.map((s) => s.subject) })), clients: CLIENTS });
  assert.equal(m.matched, true);
  assert.equal(m.matchBy, 'subject');
  assert.equal(m.companyKey, 'greenleaf');
});

test('matchReply: stays unmatched when nothing lines up (never throws, never guesses)', () => {
  const m = matchReply('stranger@nowhere.com', 'Re: random', { enrollments: ENR, clients: CLIENTS });
  assert.equal(m.matched, false);
  assert.equal(m.matchBy, 'none');
  assert.equal(m.companyKey, '');
});

test('matchReply: no email and no subject → unmatched', () => {
  const m = matchReply('', '', { enrollments: ENR, clients: CLIENTS });
  assert.equal(m.matched, false);
});

test('matchReply: threads on In-Reply-To/References even from a different address', () => {
  const enr = [{ _id: 'e9', toEmail: 'buyer@greenleaf.com', companyKey: 'greenleaf', companyName: 'Green Leaf',
    messageIds: ['<abc123@mail.jointprinting.com>'] }];
  // Reply comes from the OWNER'S personal gmail (would otherwise be UNMATCHED),
  // but carries the original Message-ID in References → thread match.
  const m = matchReply('personal@gmail.com', 'Re: whatever',
    { enrollments: enr, messageIds: ['<abc123@mail.jointprinting.com>'] });
  assert.equal(m.matched, true);
  assert.equal(m.matchBy, 'thread');
  assert.equal(m.companyKey, 'greenleaf');
  assert.equal(m.enrollmentId, 'e9');
});

test('matchReply: soft domain fallback for a business domain, but never for freemail', () => {
  const enr = [{ _id: 'e5', toEmail: 'info@highlanddispo.com', companyKey: 'highland', companyName: 'Highland' }];
  // Different mailbox, same business domain → soft 'domain' match.
  const soft = matchReply('owner@highlanddispo.com', 'Re: merch', { enrollments: enr });
  assert.equal(soft.matched, true);
  assert.equal(soft.matchBy, 'domain');
  assert.equal(soft.companyKey, 'highland');
  // A shared freemail domain must NOT domain-match (many shops use gmail).
  const gmailEnr = [{ _id: 'e6', toEmail: 'shopA@gmail.com', companyKey: 'shopa', companyName: 'Shop A' }];
  const none = matchReply('shopB@gmail.com', 'Re: hi', { enrollments: gmailEnr });
  assert.equal(none.matched, false);
  assert.equal(none.matchBy, 'none');
});

// ── worklistFromReplies (Follow-Up Command Center, Release 2) ────────────────────
test('worklistFromReplies groups open replies into the action buckets', () => {
  const now = Date.now();
  const rep = (over) => ({ receivedAt: new Date(now - (over.age || 0)), ...over });
  const replies = [
    rep({ status: 'new', category: 'hot_lead' }),          // needsResponse (hot)
    rep({ status: 'new', category: 'needs_response' }),    // needsResponse
    rep({ status: 'new', category: 'asked_pricing' }),     // needsResponse (hot)
    rep({ status: 'quote_requested', category: 'asked_pricing' }), // quoteRequested
    rep({ status: 'mockup_requested', category: 'asked_mockups' }), // mockupRequested
    rep({ status: 'follow_up', category: 'follow_up_later' }),      // followUp
    // These must NOT appear — terminal / noise:
    rep({ status: 'new', category: 'unsubscribe' }),
    rep({ status: 'new', category: 'not_interested' }),
    rep({ status: 'new', category: 'bounce_auto_ignore' }),
    rep({ status: 'handled', category: 'hot_lead' }),
    rep({ status: 'do_not_contact', category: 'hot_lead' }),
    rep({ status: 'ignored', category: 'needs_response' }),
  ];
  const w = worklistFromReplies(replies);
  assert.equal(w.needsResponse.length, 3);
  assert.equal(w.quoteRequested.length, 1);
  assert.equal(w.mockupRequested.length, 1);
  assert.equal(w.followUp.length, 1);
});

test('worklistFromReplies sorts buying signals to the top of needs-response', () => {
  const now = Date.now();
  const replies = [
    { status: 'new', category: 'needs_response', receivedAt: new Date(now) },       // newest, but not hot
    { status: 'new', category: 'hot_lead',       receivedAt: new Date(now - 5000) }, // older, but hot
    { status: 'new', category: 'asked_pricing',  receivedAt: new Date(now - 9000) }, // oldest, but hot
  ];
  const w = worklistFromReplies(replies);
  // Both hot ones come before the plain needs_response, despite being older.
  assert.ok(['hot_lead', 'asked_pricing'].includes(w.needsResponse[0].category));
  assert.ok(['hot_lead', 'asked_pricing'].includes(w.needsResponse[1].category));
  assert.equal(w.needsResponse[2].category, 'needs_response');
});

test('worklistFromReplies never throws on empty / missing dates', () => {
  const w = worklistFromReplies([{ status: 'new', category: 'hot_lead' }]); // no receivedAt
  assert.equal(w.needsResponse.length, 1);
  const empty = worklistFromReplies([]);
  assert.deepEqual(empty, { needsResponse: [], quoteRequested: [], mockupRequested: [], followUp: [] });
});

// ── Wave 2: Gmail ingest pure helpers ─────────────────────────────────────────
const { parseFromHeader, gmailQuery } = require('../../services/replyTriage');
test('parseFromHeader pulls email + name from an RFC5322 From header', () => {
  assert.deepEqual(parseFromHeader('Sam Rivera <sam@shop.com>'), { email: 'sam@shop.com', name: 'Sam Rivera' });
  assert.deepEqual(parseFromHeader('"Rivera, Sam" <SAM@Shop.com>'), { email: 'sam@shop.com', name: 'Rivera, Sam' });
  assert.deepEqual(parseFromHeader('bare@shop.com'), { email: 'bare@shop.com', name: '' });
  assert.deepEqual(parseFromHeader('not an email'), { email: '', name: '' });
  assert.deepEqual(parseFromHeader(''), { email: '', name: '' });
});

test('gmailQuery targets recent inbound, not our own mail or chats', () => {
  const q = gmailQuery({ windowDays: 7 });
  assert.match(q, /newer_than:7d/);
  assert.match(q, /-from:me/);
  assert.match(q, /-in:chats/);
  assert.match(gmailQuery({ windowDays: 2 }), /newer_than:2d/);
});

// ── Async bounce NDRs (Gmail SMTP reports dead mailboxes as EMAILS) ───────────
test('classifyBounceNdr: a Gmail hard-bounce NDR yields the failed recipient', () => {
  const ndr = classifyBounceNdr({
    fromEmail: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Failure)',
    snippet: "Your message wasn't delivered to buds@deadshop.com because the address couldn't be found. Address not found.",
  }, ['jointprintingshop.com', 'jointprinting.com']);
  assert.equal(ndr.isBounce, true);
  assert.equal(ndr.hard, true);
  assert.deepEqual(ndr.emails, ['buds@deadshop.com']);
});

test('classifyBounceNdr: SOFT failures (mailbox full / deferred) never suppress', () => {
  const full = classifyBounceNdr({
    fromEmail: 'mailer-daemon@googlemail.com',
    subject: 'Delivery Status Notification (Delay)',
    snippet: 'Delivery to info@busyshop.com delayed — mailbox full. Will retry.',
  }, []);
  assert.equal(full.isBounce, true);
  assert.equal(full.hard, false); // soft → do nothing
  // Ambiguous (bounce shape, no permanent signal) → also NOT hard.
  const vague = classifyBounceNdr({
    fromEmail: 'postmaster@somewhere.com',
    subject: 'Undeliverable: quick question',
    snippet: 'Message could not be delivered.',
  }, []);
  assert.equal(vague.isBounce, true);
  assert.equal(vague.hard, false);
});

test('classifyBounceNdr: our own domains + daemons are never the failed recipient', () => {
  const ndr = classifyBounceNdr({
    fromEmail: 'mailer-daemon@googlemail.com',
    subject: 'Mail delivery failed: returning message',
    snippet: 'From: nate@jointprintingshop.com To: gone@shop.com — user unknown. Contact postmaster@shop.com.',
  }, ['jointprintingshop.com']);
  assert.equal(ndr.hard, true);
  assert.deepEqual(ndr.emails, ['gone@shop.com']); // ours + postmaster filtered out
});

test('classifyBounceNdr: a normal human reply is not a bounce', () => {
  const r = classifyBounceNdr({
    fromEmail: 'owner@shop.com',
    subject: 'Re: quick question',
    snippet: 'Sure, send me prices.',
  }, []);
  assert.deepEqual(r, { isBounce: false, hard: false, emails: [] });
});
