// controllers/__tests__/repairReply.test.js
//
// Repairing a reply that was stored before the reader could decode MIME.
//
// Those rows hold boundary markers and base64 where the words should be, so they
// were filed on gibberish — a buyer asking for pricing is sitting in the
// database as machine noise. Nothing could rescue them: re-classifying reads the
// same garbage, and re-ingesting was refused by the message-id dedupe. So the
// dedupe now lets a DECODED copy through to rewrite the row.
//
// The rule that matters most here is the one about whose decision wins. The
// machine's filing gets overturned; the owner's never does.
//
//   node --test controllers/__tests__/repairReply.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const updates = [];

function stub(path, exports) {
  const filename = require.resolve(path);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

// Only the model is stubbed — the real classifier decides the category, so these
// tests break if the classification rules drift.
stub('../../models/TriageReply', {
  updateOne: async (filter, update) => { updates.push({ filter, update }); return { modifiedCount: 1 }; },
  find: () => ({ select: () => ({ lean: async () => [] }) }),
  findOne: () => ({ select: () => ({ lean: async () => null }) }),
});

const { repairStoredReply } = require('../replyTriage');

const DECODED = 'Thanks for reaching out — what would 100 hoodies run us? We’d want our logo on the back.';
const RAW = 'Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n'
  + 'VGhhbmtzIGZvciByZWFjaGluZyBvdXQuIFdoYXQgd291bGQgMTAwIGhvb2RpZXMgcnVuIHVzPw=='.repeat(3);

const repair = (dup, body = DECODED) => repairStoredReply(
  { snippet: RAW, ...dup },
  { subject: 'Re: merch', body, snippet: body.slice(0, 600), fromEmail: 'dana@shop.com', fromName: 'Dana', headers: null },
);

test('a reply the MACHINE filed as noise comes back to the worklist', async () => {
  updates.length = 0;
  const out = await repair({ _id: 'r1', category: 'bounce_auto_ignore', status: 'ignored', matched: true });
  assert.equal(out.repaired, true);
  assert.equal(out.promoted, true);
  assert.equal(out.category, 'asked_mockups');           // "logo" — real intent
  const { $set } = updates[0].update;
  assert.equal($set.status, 'new');                       // back in front of the owner
  assert.equal($set.handledAt, null);
  assert.equal($set.snippet, DECODED);                    // and readable now
  assert.match($set.suggestedAction, /mockup/i);
});

test('an untouched new row is repaired the same way', async () => {
  updates.length = 0;
  const out = await repair({ _id: 'r2', category: 'bounce_auto_ignore', status: 'new', matched: true });
  assert.equal(out.promoted, true);
  assert.equal(updates[0].update.$set.status, 'new');
});

// ── The owner's decision is not up for review ────────────────────────────────

test('a reply the OWNER triaged keeps his status, text fixed underneath', async () => {
  for (const status of ['not_interested', 'do_not_contact', 'handled', 'follow_up']) {
    updates.length = 0;
    const out = await repair({ _id: 'r3', category: 'not_interested', status, matched: true });
    assert.equal(out.repaired, true);
    assert.equal(out.promoted, false, status);
    const { $set } = updates[0].update;
    assert.equal($set.status, undefined, `${status} must survive a re-decode`);
    assert.equal($set.snippet, DECODED);                  // the text still gets fixed
  }
});

test('a row the owner ignored that is NOT machine-filed keeps its status', async () => {
  // Category was already a human one, so 'ignored' here was the owner dismissing
  // it — not the classifier hiding it.
  updates.length = 0;
  const out = await repair({ _id: 'r4', category: 'needs_response', status: 'ignored', matched: true });
  assert.equal(out.promoted, false);
  assert.equal(updates[0].update.$set.status, undefined);
});

// ── Repair never invents a lead ──────────────────────────────────────────────

test('a decoded body that really IS noise stays filed as noise', async () => {
  updates.length = 0;
  const out = await repair(
    { _id: 'r5', category: 'bounce_auto_ignore', status: 'ignored', matched: true },
    'This mailbox is not monitored. Do not reply to this email.',
  );
  assert.equal(out.promoted, false);
  assert.equal(out.category, 'bounce_auto_ignore');
  assert.equal(updates[0].update.$set.status, undefined);  // stays out of the worklist
});

test('a decoded opt-out is filed as an opt-out, not as a lead', async () => {
  updates.length = 0;
  const out = await repair(
    { _id: 'r6', category: 'bounce_auto_ignore', status: 'ignored', matched: true },
    'Please take us off your list.',
  );
  assert.equal(out.category, 'unsubscribe');
  assert.equal(out.promoted, true);   // surfaced so the owner sees it was honored
});

test('an out-of-office decodes fine but is not resurfaced', async () => {
  // A real mailbox, temporarily away — nothing to answer, and the sequence's own
  // snooze already handles it. Repair fixes the text without putting it back in
  // the worklist.
  updates.length = 0;
  const out = await repair(
    { _id: 'r7', category: 'bounce_auto_ignore', status: 'ignored', matched: true },
    'I am currently out of the office until 8/14 with limited access to email.',
  );
  assert.equal(out.category, 'auto_reply_ooo');
  assert.equal(out.promoted, false);
  assert.equal(updates[0].update.$set.status, undefined);
});
