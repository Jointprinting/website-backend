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

test('auto-responder is IGNORED, never a real reply (the Origins Cannabis bug)', () => {
  // The exact live case: an "Auto response:" from the shop's REAL address whose
  // body is a generic auto-ack. It must NOT be treated as a human reply.
  const r = classifyReply({
    fromEmail: 'shop@originscannabis.com',
    fromName: 'Origins Cannabis',
    subject: 'Auto response: Custom Merch/Apparel for Origins Cannabis',
    snippet: 'Thank you for contacting Origins Cannabis. Questions cannot be answered via this email account. Do not send urgent messages to this account; it is unlikely they will be seen in time.',
  });
  assert.equal(r.category, 'bounce_auto_ignore');
  assert.equal(r.ignore, true);
  assert.equal(r.auto, true);
  // Subject-only and body-only auto-ack wording each trip it, too.
  assert.equal(cat({ fromEmail: 'x@shop.com', subject: 'Auto-Response: your inquiry' }), 'bounce_auto_ignore');
  assert.equal(cat({ fromEmail: 'x@shop.com', subject: 'Re: merch', snippet: 'Please do not reply to this email; this mailbox is not monitored.' }), 'bounce_auto_ignore');
});

test('RFC auto/bulk headers catch an auto-responder regardless of wording', () => {
  // Auto-Submitted (RFC 3834) — the definitive auto-reply signal.
  assert.equal(cat({ fromEmail: 'a@shop.com', subject: 'Re: merch', snippet: 'sure, sounds good', headers: { 'Auto-Submitted': 'auto-replied' } }), 'bounce_auto_ignore');
  // Precedence: bulk, and a mailing-list header — bulk/list mail, not a person.
  assert.equal(cat({ fromEmail: 'a@shop.com', subject: 'Newsletter', headers: { Precedence: 'bulk' } }), 'bounce_auto_ignore');
  assert.equal(cat({ fromEmail: 'a@shop.com', subject: 'Update', headers: { 'List-Id': '<news.shop.com>' } }), 'bounce_auto_ignore');
  // Exchange/Outlook auto-response suppression header.
  assert.equal(cat({ fromEmail: 'a@shop.com', subject: 'Re: hi', headers: { 'X-Auto-Response-Suppress': 'All' } }), 'bounce_auto_ignore');
  // Auto-Submitted: no is a NORMAL human message — must NOT trip.
  assert.equal(cat({ fromEmail: 'a@shop.com', subject: 'Re: merch', snippet: "let's talk, we're interested", headers: { 'Auto-Submitted': 'no' } }), 'hot_lead');
});

test('a genuine human reply is untouched by the auto filters', () => {
  // "thanks for reaching out" (not "thank you for contacting") stays a real lead.
  assert.equal(cat({ fromEmail: 'buyer@shop.com', subject: 'Re: Custom merch', snippet: "Thanks for reaching out — we're interested, can you send pricing?" }), 'asked_pricing');
  assert.equal(cat({ fromEmail: 'buyer@shop.com', subject: 'Re: Custom merch', snippet: "Let's set up a call this week." }), 'hot_lead');
});

test('a polite human opener is NOT swallowed as an auto-ack (no over-correction)', () => {
  // A real buyer commonly opens with "Thank you for your email" — this must NOT be
  // treated as a machine auto-ack (regression guard for the auto-reply fix).
  assert.equal(cat({ fromEmail: 'buyer@shop.com', subject: 'Re: Custom merch', snippet: "Thank you for your email — yes, we'd love a quote, what's your pricing on 250 tees?" }), 'asked_pricing');
  assert.equal(cat({ fromEmail: 'buyer@shop.com', subject: 'Re: Custom merch', snippet: 'Thank you for your message! Interested — can you send a mockup?' }), 'asked_mockups');
});

test('auto-ack COMBO: acknowledge + defer-to-later is ignored (novel dispensary autoresponder)', () => {
  // The wording that slipped past subject/body patterns: a real, monitored
  // address that opens by acknowledging us and then defers a real answer.
  assert.equal(cat({
    fromEmail: 'hello@originscannabis.com', fromName: 'Origins',
    subject: 'Re: Custom merch for Origins',
    snippet: "Thanks for reaching out! We've received your message and a member of our team will get back to you within 24-48 hours.",
  }), 'bounce_auto_ignore');
  assert.equal(cat({
    fromEmail: 'info@shop.com', subject: 'Re: hats',
    snippet: 'Thank you for contacting us. Due to high volume, we will respond as soon as possible.',
  }), 'bounce_auto_ignore');
});

test('auto-ack COMBO does NOT swallow a real lead that only acknowledges (no defer)', () => {
  // Acknowledgement WITHOUT a no-substance defer-to-later promise stays a real
  // lead — the combo needs BOTH halves, so buying intent always wins.
  assert.equal(cat({ fromEmail: 'buyer@shop.com', subject: 'Re: merch',
    snippet: "Thanks for reaching out! We've received your message and yes, we'd love a quote on 200 hoodies." }), 'asked_pricing');
  assert.equal(cat({ fromEmail: 'buyer@shop.com', subject: 'Re: merch',
    snippet: 'Thanks for contacting us — someone will be in touch, but quick q: can you send a mockup first?' }), 'asked_mockups');
});

test('matchReply: an ambiguous subject shared by two companies does NOT auto-pick one', () => {
  // Same generic subject on enrollments for two different shops (shared host) →
  // must NOT strong-match/warm the first one; left unmatched for manual triage.
  const enr = [
    { _id: 'a', toEmail: 'a@sharedhost.com', companyKey: 'shopa', companyName: 'Shop A', subjects: ['Quick question'] },
    { _id: 'b', toEmail: 'b@sharedhost.com', companyKey: 'shopb', companyName: 'Shop B', subjects: ['Quick question'] },
  ];
  const m = matchReply('someoneelse@gmail.com', 'Re: Quick question', { enrollments: enr });
  assert.equal(m.matched, false);
  assert.equal(m.matchBy, 'none');
  // But when the subject resolves to a SINGLE company, it still matches.
  const one = matchReply('someoneelse@gmail.com', 'Re: Quick question', { enrollments: [enr[0]] });
  assert.equal(one.matched, true);
  assert.equal(one.matchBy, 'subject');
  assert.equal(one.companyKey, 'shopa');
});

test('a true out-of-office still SNOOZES (not ignored) even with auto headers', () => {
  const r = classifyReply({ fromEmail: 'sam@shop.com', subject: 'Automatic reply: Out of office', headers: { 'Auto-Submitted': 'auto-replied' } });
  assert.equal(r.category, 'auto_reply_ooo');   // OOO precedence over generic ignore
  assert.equal(r.ooo, true);
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

// ── v2 auto-ack net (the "Origins Cannabis" class of miss) ───────────────────
// Dispensary/support autoresponders that carry no RFC auto headers and dodge
// the v1 wording. Machine-specific phrases only — a warm human reply that
// happens to open politely must still triage as human.
test('classifyReply v2: ticket/receipt-style auto-acks are ignored', () => {
  for (const s of [
    { subject: 'We have received your message', snippet: 'Our team will get back to you shortly.' },
    { subject: 'Thank you for contacting Origins Cannabis', snippet: 'A member of our team will be in touch.' },
    { subject: 'Re: quick question', snippet: 'Your request has been received and a support ticket has been created. Ticket #48221.' },
    { subject: 'Auto-Response', snippet: 'anything' },
  ]) {
    const cls = classifyReply({ ...s, fromEmail: 'info@dispensary.com' });
    assert.equal(cls.category, 'bounce_auto_ignore', s.subject);
    assert.equal(cls.ignore, true);
  }
});

test('classifyReply v2: real human replies still triage as human', () => {
  for (const s of [
    { subject: 'Re: staff tees', snippet: 'Thanks for reaching out! Yes — can you send pricing for 50 hoodies?' },
    { subject: 'Re: merch', snippet: 'We received your email — love the idea. What are your minimums?' },
    { subject: 'Re: mockups', snippet: 'I will get back to you Monday after I talk to my partner.' },
  ]) {
    const cls = classifyReply({ ...s, fromEmail: 'buyer@shop.com' });
    assert.notEqual(cls.category, 'bounce_auto_ignore', s.subject);
  }
});

// ── Soft-bounce classification (Gmail "will retry" notices) ──────────────────
test('classifyBounceNdr: soft notices flag soft (never hard)', () => {
  const r = classifyBounceNdr({
    subject: 'Delivery incomplete',
    snippet: 'There was a temporary problem delivering your message to contact@silverleaf406.com. Gmail will retry for 46 more hours.',
    fromEmail: 'mailer-daemon@googlemail.com',
  }, ['jointprintingshop.com']);
  assert.equal(r.isBounce, true);
  assert.equal(r.hard, false);
  assert.equal(r.soft, true);
  assert.deepEqual(r.emails, ['contact@silverleaf406.com']);
});

test('classifyBounceNdr: hard failures stay hard (not soft)', () => {
  const r = classifyBounceNdr({
    subject: 'Delivery Status Notification (Failure)',
    snippet: 'The address you tried was not found: ghost@deadshop.com — 550 5.1.1 user unknown.',
    fromEmail: 'mailer-daemon@googlemail.com',
  }, ['jointprintingshop.com']);
  assert.equal(r.hard, true);
  assert.equal(r.soft, false);
});
