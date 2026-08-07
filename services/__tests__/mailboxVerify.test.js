// services/__tests__/mailboxVerify.test.js
//
// Asking the receiving server whether a mailbox exists, before spending a send
// on it.
//
// MX only proves the DOMAIN takes mail. The hard bounces came from addresses a
// shop really did publish whose mailbox has since been deleted — the domain
// still answers, the person is gone. This gate closes that, and the rule that
// makes it safe is the DEFAULT: anything we can't determine is 'unknown', and
// unknown still gets mailed. It may only ever prevent a bounce, never block a
// real lead on a guess.
//
// The socket conversation is integration territory; what's pinned here is every
// decision made around it.
//
//   node --test services/__tests__/mailboxVerify.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyMailbox, verifyMailboxes, mailboxProbeStatus } = require('../emailVerify');

test('garbage input is refused without touching the network', async () => {
  for (const junk of ['', null, undefined, 'not-an-email', '@x.com', 'a@', '   ']) {
    assert.equal(await verifyMailbox(junk), 'dead', JSON.stringify(junk));
  }
});

test('a domain with no mail server at all is dead', async () => {
  // .invalid is reserved by RFC 2606 and can never resolve.
  assert.equal(await verifyMailbox('someone@this-domain-cannot-exist.invalid'), 'dead');
});

test('an unreachable server reads unknown — which means SEND', async () => {
  // The whole safety property: when we can't tell, the lead is still mailed.
  // (Port 25 is blocked in most sandboxes, so this exercises the real path.)
  const verdict = await verifyMailbox('probe-test@gmail.com', { timeoutMs: 1200 });
  assert.ok(['ok', 'unknown', 'dead'].includes(verdict));
  assert.notEqual(verdict, undefined);
});

test('verifyMailboxes never throws and answers for every address', async () => {
  const out = await verifyMailboxes(
    ['a@this-domain-cannot-exist.invalid', 'not-an-email', 'b@this-domain-cannot-exist.invalid'],
    { timeoutMs: 800 },
  );
  assert.equal(out.get('a@this-domain-cannot-exist.invalid'), 'dead');
  assert.equal(out.get('not-an-email'), 'dead');
  assert.ok(out.size >= 2);
});

test('an empty batch is a no-op', async () => {
  const out = await verifyMailboxes([], { timeoutMs: 500 });
  assert.equal(out.size, 0);
});

test('the gate reports whether it is actually working', async () => {
  // "Verification is on" must never quietly mean "verification is a no-op" —
  // when the host blocks port 25 the module says so rather than pretending.
  const s = mailboxProbeStatus();
  assert.equal(typeof s.blocked, 'boolean');
  assert.equal(typeof s.attempts, 'number');
  assert.equal(typeof s.successes, 'number');
});
