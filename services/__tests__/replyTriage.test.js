// services/__tests__/replyTriage.test.js
//
// Reply-pipeline ratchets — the five ways a REAL reply used to disappear before
// the owner ever saw it. Each fails "toward silence", which is why none of them
// showed up as an error anywhere:
//
//   1. our own quoted footer ("Reply 'unsubscribe' to opt out") tripped the
//      opt-out regex, so answering a pitch could permanently suppress the lead
//   2. one bulk RFC header hard-ignored a message before any intent check ran —
//      and every shop on Shopify/Dutchie/Square/a helpdesk stamps those
//   3. the Gmail query never looked in Spam or Trash, where cold replies land
//   4. the sync read one un-paged page in a rolling window, so any gap was lost
//   5. per-message failures were swallowed, so a broken ingest looked like a
//      quiet mailbox
//
// The classifier + the sync's paging/window math are pure, so all of it is
// pinned here with no DB and no network — same convention as the rest of the
// suite (the category/matcher basics live in controllers/__tests__/replyTriage).
//
//   node --test services/__tests__/replyTriage.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyReply,
  stripQuotedReply,
  hasHumanSignal,
  gmailQuery,
} = require('../replyTriage');

const { syncWindowDays, collectMessageIds, MAX_SYNC_PAGES } = require('../../controllers/replyTriage');

// The footer every outreach send carries (services/outreachEngine composeMessage).
const OUR_FOOTER = '--\nReply "unsubscribe" to opt out.';

// ── 1. Quoted-reply stripping ────────────────────────────────────────────────

test('stripQuotedReply drops a Gmail-style quote and keeps what they typed', () => {
  const raw = [
    'Yes! Send pricing on 250 tees please.',
    '',
    'On Mon, Jul 6, 2026 at 9:02 AM Nate <nate@jointprintingshop.com> wrote:',
    '> Hey, we print custom merch for dispensaries...',
    `> ${OUR_FOOTER}`,
  ].join('\n');
  assert.equal(stripQuotedReply(raw), 'Yes! Send pricing on 250 tees please.');
});

test('stripQuotedReply handles a COLLAPSED Gmail snippet (no newlines at all)', () => {
  // This is the shape the sync actually receives — msg.snippet is one line.
  const snippet = 'Sounds great, what would 200 hoodies run us? On Mon, Jul 6, 2026 at 9:02 AM Nate wrote: Hey there — we print custom merch... Reply "unsubscribe" to opt out.';
  assert.equal(stripQuotedReply(snippet), 'Sounds great, what would 200 hoodies run us?');
});

test('stripQuotedReply cuts at Outlook, divider, mobile-sig and our own footer', () => {
  assert.equal(stripQuotedReply('Interested.\n-----Original Message-----\nFrom: Nate'), 'Interested.');
  assert.equal(stripQuotedReply('Interested.\n________________________________\nFrom: Nate'), 'Interested.');
  assert.equal(stripQuotedReply('Interested.\nFrom: Nate <n@x.com> Sent: Monday'), 'Interested.');
  assert.equal(stripQuotedReply('Interested.\n\nSent from my iPhone\n\nOn Jul 6 Nate wrote:'), 'Interested.');
  assert.equal(stripQuotedReply(`Interested.\n\n${OUR_FOOTER}`), 'Interested.');
  // Our signature line goes; a bare name above it is harmless residue.
  const sig = stripQuotedReply('Interested.\n\nNate\nJoint Printing · jointprinting.com\n\nReply "unsubscribe" to opt out.');
  assert.ok(sig.startsWith('Interested.'));
  assert.doesNotMatch(sig, /jointprinting\.com|unsubscribe/i);
});

test('stripQuotedReply degrades safely on junk input', () => {
  assert.equal(stripQuotedReply(''), '');
  assert.equal(stripQuotedReply(null), '');
  assert.equal(stripQuotedReply(undefined), '');
  assert.equal(stripQuotedReply('   '), '');
  // A message that is nothing BUT our quoted footer leaves no new text.
  assert.equal(stripQuotedReply(`> ${OUR_FOOTER}`), '');
  // Plain text with no quote survives untouched.
  assert.equal(stripQuotedReply('Just checking in on that quote.'), 'Just checking in on that quote.');
});

// ── THE regression: a positive reply must not unsubscribe the lead ───────────

test('a POSITIVE reply quoting our footer is NOT an opt-out', () => {
  const r = classifyReply({
    fromEmail: 'buyer@greenleaf.com',
    subject: 'Re: custom merch for Green Leaf',
    snippet: `Yes — very interested, can you send pricing for 250 tees?\n\nOn Mon, Jul 6, 2026 Nate wrote:\n> ${OUR_FOOTER}`,
  });
  assert.notEqual(r.category, 'unsubscribe');
  assert.equal(r.category, 'asked_pricing');
  assert.equal(r.ignore, false);
});

test('the collapsed-snippet form of the same reply is also safe', () => {
  const r = classifyReply({
    fromEmail: 'buyer@greenleaf.com',
    subject: 'Re: custom merch for Green Leaf',
    snippet: 'let’s do it, call me this week. On Mon, Jul 6, 2026 at 9:02 AM Nate wrote: ... Reply "unsubscribe" to opt out.',
  });
  assert.equal(r.category, 'hot_lead');
});

test('a bland reply that quotes our footer is needs_response, not unsubscribe', () => {
  const r = classifyReply({
    fromEmail: 'info@shop.com',
    subject: 'Re: quick question',
    snippet: `Got it, thanks.\n\n> Don't want these? Reply "unsubscribe" and we'll take you off the list.`,
  });
  assert.equal(r.category, 'needs_response');
});

test('a REAL opt-out typed by the human IS still honored (both directions pinned)', () => {
  const typed = classifyReply({
    fromEmail: 'info@shop.com',
    subject: 'Re: custom merch',
    snippet: `Please unsubscribe me, we don't want these emails.\n\nOn Mon, Jul 6 Nate wrote:\n> ${OUR_FOOTER}`,
  });
  assert.equal(typed.category, 'unsubscribe');

  for (const s of ['unsubscribe', 'take me off your list', 'remove me from this list', 'stop emailing us', 'please opt out']) {
    assert.equal(classifyReply({ fromEmail: 'a@shop.com', snippet: s }).category, 'unsubscribe', s);
  }
  // Subject-line opt-out still counts (the subject is theirs, never quoted).
  assert.equal(classifyReply({ fromEmail: 'a@shop.com', subject: 'unsubscribe' }).category, 'unsubscribe');
});

test('an opt-out written in the PLURAL is an opt-out', () => {
  // A buyer answers for the shop, not for themselves — "take US off", "remove
  // OUR email". Matching only the singular kept these people enrolled and
  // mailing, which is a compliance failure and not merely a mis-filed row.
  for (const s of [
    'Please take us off your list.',
    'remove us from your mailing list',
    'Please remove our email from your database.',
    'delete us from this list please',
    'no more emails please',
    'stop reaching out',
  ]) {
    assert.equal(classifyReply({ fromEmail: 'a@shop.com', snippet: s }).category, 'unsubscribe', s);
  }
  // …and the phrasing stays specific: ordinary replies must not trip it.
  for (const s of ['Can you take a look at our logo?', 'We removed that item from the order.']) {
    assert.notEqual(classifyReply({ fromEmail: 'a@shop.com', snippet: s }).category, 'unsubscribe', s);
  }
});

test('"not interested" from the human sticks; from our quoted pitch it does not', () => {
  assert.equal(classifyReply({ fromEmail: 'a@shop.com', snippet: 'Not interested, thanks.' }).category, 'not_interested');
  const quoted = classifyReply({
    fromEmail: 'a@shop.com',
    subject: 'Re: merch',
    snippet: 'Sure, send it over.\n\nOn Mon Nate wrote:\n> not interested? no problem, just say the word\n> we already work with plenty of shops',
  });
  assert.notEqual(quoted.category, 'not_interested');
});

// ── 2. Bulk headers are evidence, not a veto ─────────────────────────────────

test('hasHumanSignal reads only typed text and ignores blasts', () => {
  assert.equal(hasHumanSignal('Re: merch', 'yes please send a quote'), true);
  assert.equal(hasHumanSignal('Re: merch', 'thanks — what are your minimums?'), true);
  assert.equal(hasHumanSignal('Re: merch', ''), false);          // nothing new typed
  assert.equal(hasHumanSignal('Re: merch', '   '), false);
  assert.equal(hasHumanSignal('20% off ends tonight', 'shop the sale, view in browser'), false);
});

test('a List-Unsubscribe reply that MATCHES a known thread is not auto-ignored', () => {
  const fields = {
    fromEmail: 'orders@greenleaf.com',
    subject: 'Re: custom merch for Green Leaf',
    snippet: 'Thanks Nate — can you send pricing on 250 tees?',
    headers: { 'list-unsubscribe': '<https://shop.example/unsub>', 'x-auto-response-suppress': 'All' },
  };
  // Unmatched: unchanged behavior — the header still hard-ignores.
  const cold = classifyReply(fields);
  assert.equal(cold.category, 'bounce_auto_ignore');
  assert.equal(cold.bulkHeader, true);

  // Matched to a real send of ours: the header becomes evidence, not a veto.
  for (const matchBy of ['thread', 'email', 'subject']) {
    const hot = classifyReply({ ...fields, matched: true, matchBy });
    assert.equal(hot.category, 'asked_pricing', matchBy);
    assert.equal(hot.ignore, false, matchBy);
    assert.equal(hot.bulkHeader, true, matchBy); // evidence is preserved
  }
});

test('the override needs a STRONG match — a soft domain guess does not qualify', () => {
  const r = classifyReply({
    fromEmail: 'someoneelse@greenleaf.com',
    subject: 'Newsletter',
    snippet: 'Thanks for subscribing!',
    headers: { 'list-id': '<news.greenleaf.com>' },
    matched: true, matchBy: 'domain',
  });
  assert.equal(r.category, 'bounce_auto_ignore');
});

test('the override needs a human line — a matched bulk blast still ignores', () => {
  const r = classifyReply({
    fromEmail: 'orders@greenleaf.com',
    subject: 'Green Leaf: 20% off ends tonight',
    snippet: 'Limited-time deal on all flower. View in browser. Manage your preferences.',
    headers: { 'list-unsubscribe': '<https://shop.example/unsub>' },
    matched: true, matchBy: 'email',
  });
  assert.equal(r.category, 'bounce_auto_ignore');
});

test('genuine vendor noise and wording-based auto-acks still ignore, matched or not', () => {
  // Vendor sender domain — hard ignore stands (the Google Workspace billing case).
  assert.equal(classifyReply({
    fromEmail: 'workspace@google.com',
    subject: '[Reminder] Your Google Workspace free trial is ending',
    snippet: 'Your paid subscription starts tomorrow. Thanks for using Google Workspace, please contact us.',
    headers: { 'list-unsubscribe': '<https://google.com/unsub>' },
    matched: true, matchBy: 'email',
  }).category, 'bounce_auto_ignore');

  // "This mailbox is not monitored" is a machine no matter who it matches.
  assert.equal(classifyReply({
    fromEmail: 'info@shop.com',
    subject: 'Re: custom merch',
    snippet: 'Thanks for your email! This mailbox is not monitored. Please send pricing requests to our website.',
    headers: { 'list-unsubscribe': '<https://shop.example/unsub>' },
    matched: true, matchBy: 'thread',
  }).category, 'bounce_auto_ignore');

  // Auto-Submitted: auto-replied, no human line → still ignored.
  assert.equal(classifyReply({
    fromEmail: 'info@shop.com',
    subject: 'Auto response: your message',
    snippet: 'We have received your message.',
    headers: { 'auto-submitted': 'auto-replied' },
    matched: true, matchBy: 'thread',
  }).category, 'bounce_auto_ignore');
});

test('an opt-out carrying bulk headers is honored as an opt-out, not swallowed', () => {
  const r = classifyReply({
    fromEmail: 'info@shop.com',
    subject: 'Re: custom merch',
    snippet: 'Please take me off your list.',
    headers: { 'list-unsubscribe': '<mailto:unsub@shop.com>' },
    matched: true, matchBy: 'email',
  });
  assert.equal(r.category, 'unsubscribe');
});

// ── 3. Spam / Trash coverage ─────────────────────────────────────────────────

test('gmailQuery searches everywhere (spam + trash) but never chats or drafts', () => {
  const q = gmailQuery({ windowDays: 7 });
  assert.match(q, /in:anywhere/);        // without this Gmail searches the inbox only
  assert.match(q, /newer_than:7d/);
  assert.match(q, /-from:me/);
  assert.match(q, /-in:chats/);
  assert.match(q, /-in:drafts/);
  assert.match(gmailQuery({ windowDays: 30 }), /newer_than:30d/);
  assert.match(gmailQuery({ windowDays: 0 }), /newer_than:1d/);  // floor
});

// ── 4. Pagination + a recoverable window ─────────────────────────────────────

const page = (ids, nextPageToken) => ({ messages: ids.map((id) => ({ id })), ...(nextPageToken ? { nextPageToken } : {}) });

test('collectMessageIds follows pageToken to the end of a short result set', async () => {
  const pages = { '': page(['a', 'b'], 't1'), t1: page(['c']) };
  const seen = [];
  const r = await collectMessageIds((tok) => { seen.push(tok); return Promise.resolve(pages[tok]); });
  assert.deepEqual(r.ids, ['a', 'b', 'c']);
  assert.deepEqual(seen, ['', 't1']);
  assert.equal(r.pages, 2);
  assert.equal(r.truncated, false);      // nothing left → the cursor may advance
});

test('collectMessageIds is bounded by maxMessages and maxPages, and says so', async () => {
  const fetchPage = () => Promise.resolve(page(['x', 'y', 'z'], 'more'));
  const byMessages = await collectMessageIds(fetchPage, { maxMessages: 5, maxPages: 50 });
  assert.equal(byMessages.ids.length, 5);
  assert.equal(byMessages.truncated, true);

  const byPages = await collectMessageIds(fetchPage, { maxMessages: 10000, maxPages: 3 });
  assert.equal(byPages.pages, 3);
  assert.equal(byPages.ids.length, 9);
  assert.equal(byPages.truncated, true); // a cron tick can never run away
  assert.ok(MAX_SYNC_PAGES >= 1 && MAX_SYNC_PAGES <= 50);
});

test('collectMessageIds tolerates an empty mailbox', async () => {
  const r = await collectMessageIds(() => Promise.resolve({}));
  assert.deepEqual(r.ids, []);
  assert.equal(r.truncated, false);
});

test('syncWindowDays widens to cover the gap since the last COMPLETE sync', () => {
  const now = new Date('2026-07-27T12:00:00Z');
  // Healthy: synced an hour ago → the plain rolling window.
  assert.equal(syncWindowDays({ windowDays: 7, lastCompleteAt: new Date('2026-07-27T11:00:00Z') }, now), 7);
  // Cron was down 12 days → look back far enough to recover those replies.
  assert.equal(syncWindowDays({ windowDays: 7, lastCompleteAt: new Date('2026-07-15T12:00:00Z') }, now), 13);
  // A long outage is capped so we never ask Gmail for everything ever.
  assert.equal(syncWindowDays({ windowDays: 7, lastCompleteAt: new Date('2025-01-01T00:00:00Z') }, now), 30);
  // Never synced / unreadable stamp → the plain window, no throw.
  assert.equal(syncWindowDays({ windowDays: 7, lastCompleteAt: null }, now), 7);
  assert.equal(syncWindowDays({ windowDays: 7, lastCompleteAt: 'not a date' }, now), 7);
  assert.equal(syncWindowDays({}, now), 7);
  assert.equal(syncWindowDays({ windowDays: 0, lastCompleteAt: null }, now), 1);
});

// ── 5. The triage identity never throws ──────────────────────────────────────

test('getTriageIdentity returns the contract shape and never throws', async () => {
  const { getTriageIdentity } = require('../../controllers/replyTriage');
  const prev = process.env.GMAIL_TRIAGE_ENABLED;
  delete process.env.GMAIL_TRIAGE_ENABLED;          // not configured → no network
  try {
    const id = await getTriageIdentity();           // no DB connected in tests either
    assert.equal(typeof id.address, 'string');
    assert.equal(id.configured, false);
    assert.ok(id.checkedAt === null || id.checkedAt instanceof Date);
  } finally {
    if (prev === undefined) delete process.env.GMAIL_TRIAGE_ENABLED;
    else process.env.GMAIL_TRIAGE_ENABLED = prev;
  }
});

// ── Bottom-posted kill-signals (the opt-out-promoted-to-warm-lead regression) ──
//
// stripQuotedReply() is top-post-only by design. Routing the kill-signals through
// it meant a reply whose "please remove me" sat BELOW the quoted thread lost the
// opt-out entirely — and then the full-text nets matched OUR OWN quoted sales copy
// and filed the person as a pricing enquiry. Failing to honor a stated opt-out is
// a CAN-SPAM problem, so these are pinned hard in both directions.

const OUR_QUOTED_PITCH = [
  '> Hey,',
  '> Nate here, from Joint Printing. We make custom merch for dispensaries —',
  '> hoodies, tees, grinders. Can I send over pricing and a free mockup?',
  '>',
  '> Nate · Joint Printing · jointprinting.com',
  "> Don't want these? Reply \"unsubscribe\" and we'll take you off the list.",
].join('\n');

test('a bottom-posted opt-out is honored, not filed as a pricing enquiry', () => {
  const body = `On Mon, Jul 20, 2026 at 9:02 AM Nate <nate@jointprintingshop.com> wrote:\n${OUR_QUOTED_PITCH}\n\nplease remove me from your list, we're not interested`;
  const out = classifyReply({ subject: 'Re: Merch for your shop', from: 'info@shop.com', snippet: body });
  assert.equal(out.category, 'unsubscribe', 'a stated opt-out below the quote must still stop the sequence');
  assert.equal(out.ignore, false);
});

test('an inline opt-out under an un-prefixed Outlook quote is honored', () => {
  // Outlook quotes WITHOUT '>' — our footer arrives as plain text, so the
  // redaction has to work by value, not by position.
  const body = [
    'From: Nate <nate@jointprintingshop.com>',
    'Sent: Monday, July 20, 2026 9:02 AM',
    'Subject: Merch for your shop',
    '',
    'Nate here, from Joint Printing. Can I send over pricing and a free mockup?',
    "Don't want these? Reply \"unsubscribe\" and we'll take you off the list.",
    '',
    'Take me off this list please.',
  ].join('\n');
  const out = classifyReply({ subject: 'Re: Merch for your shop', from: 'info@shop.com', snippet: body });
  assert.equal(out.category, 'unsubscribe');
});

test('our own quoted footer STILL never unsubscribes a positive reply', () => {
  const body = `Yes! Send pricing for 50 hoodies please.\n\nOn Mon, Jul 20, 2026 Nate wrote:\n${OUR_QUOTED_PITCH}`;
  const out = classifyReply({ subject: 'Re: Merch for your shop', from: 'info@shop.com', snippet: body });
  assert.notEqual(out.category, 'unsubscribe', 'our own footer must never opt someone out');
  assert.equal(out.ignore, false);
});

test('a quote-only reply with no typed words is not read as an opt-out', () => {
  const out = classifyReply({ subject: 'Re: Merch', from: 'info@shop.com', snippet: OUR_QUOTED_PITCH });
  assert.notEqual(out.category, 'unsubscribe');
});

test('senderWords keeps the human text and redacts only our own footer', () => {
  const { senderWords } = require('../replyTriage');
  const out = senderWords(`take me off\n${OUR_QUOTED_PITCH}`);
  assert.match(out, /take me off/);
  assert.doesNotMatch(out, /unsubscribe/i, 'our footer wording must be gone');
  assert.doesNotMatch(out, /jointprinting\.com/i);
  assert.equal(senderWords(''), '');
  assert.equal(senderWords(null), '');
});

test('a bottom-posted "not interested" also stops the sequence', () => {
  const body = `On Mon Nate wrote:\n${OUR_QUOTED_PITCH}\n\nno thanks, we already have a printer`;
  const out = classifyReply({ subject: 'Re: Merch', from: 'info@shop.com', snippet: body });
  assert.equal(out.category, 'not_interested');
});
