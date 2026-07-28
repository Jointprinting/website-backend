// services/__tests__/replyImap.test.js
//
// The sending mailbox reader. Cold mail goes out from a dedicated mailbox kept
// off the owner's real inbox — correct, but it meant replies landed where the
// Studio couldn't see them, and the Gmail-API sync authenticates to a SEPARATE
// hand-wired account that can point somewhere else entirely. This reader closes
// that gap using credentials the sender already holds, so there is no setup step
// to get wrong.
//
// The network parts are integration territory; everything decided in code —
// which host, whether to run at all, and how a fetched message is shaped for
// triage — is pure and pinned here.
//
//   node --test services/__tests__/replyImap.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { imapConfig, imapHostFor, imapMailbox, toRaw, flattenHeaders, addressOf } = require('../replyImap');

// ── Host derivation ──────────────────────────────────────────────────────────

test('imapHostFor maps a sending host to the mailbox that serves it', () => {
  assert.equal(imapHostFor('smtp.gmail.com'), 'imap.gmail.com');
  assert.equal(imapHostFor('SMTP.GMAIL.COM'), 'imap.gmail.com');
  assert.equal(imapHostFor('smtp.office365.com'), 'outlook.office365.com');
  assert.equal(imapHostFor(''), '');
  assert.equal(imapHostFor(null), '');
});

test('send-only relays have no mailbox to read, and say so', () => {
  // These accept mail for delivery but host no inbox — connecting would be a
  // pointless failure every ten minutes.
  for (const relay of ['smtp-relay.brevo.com', 'smtp.sendgrid.net', 'smtp.sendpulse.com',
    'smtp.mailersend.net', 'in-v3.mailjet.com']) {
    assert.equal(imapHostFor(relay), '', relay);
  }
});

// ── When to run at all ───────────────────────────────────────────────────────

const GOOGLE_ENV = {
  SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'nate@jointprintingshop.com', SMTP_PASS: 'app-password',
};

test('reuses the sender’s own credentials — no new setup', () => {
  const cfg = imapConfig(GOOGLE_ENV);
  assert.equal(cfg.host, 'imap.gmail.com');
  assert.equal(cfg.port, 993);
  assert.equal(cfg.secure, true);
  assert.equal(cfg.auth.user, 'nate@jointprintingshop.com');
  assert.equal(cfg.auth.pass, 'app-password');
  assert.equal(imapMailbox(GOOGLE_ENV), 'nate@jointprintingshop.com');
});

test('idle without credentials, on a send-only relay, or when switched off', () => {
  assert.equal(imapConfig({}), null);
  assert.equal(imapConfig({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'a@b.com' }), null);   // no pass
  assert.equal(imapConfig({ SMTP_HOST: 'smtp.gmail.com', SMTP_PASS: 'p' }), null);          // no user
  assert.equal(imapConfig({ SMTP_HOST: 'smtp.sendgrid.net', SMTP_USER: 'a@b.com', SMTP_PASS: 'p' }), null);
  assert.equal(imapConfig({ ...GOOGLE_ENV, OUTREACH_IMAP: 'off' }), null);
  assert.equal(imapMailbox({}), '');
});

test('explicit IMAP_* settings override the derived ones', () => {
  const cfg = imapConfig({ ...GOOGLE_ENV, IMAP_HOST: 'mail.example.com', IMAP_PORT: '143', IMAP_USER: 'other@x.com', IMAP_PASS: 'p2' });
  assert.equal(cfg.host, 'mail.example.com');
  assert.equal(cfg.port, 143);
  assert.equal(cfg.secure, false);
  assert.equal(cfg.auth.user, 'other@x.com');
});

// ── Message shaping ──────────────────────────────────────────────────────────

test('toRaw shapes a fetched message into what triage expects', () => {
  const headers = new Map([
    ['message-id', '<abc123@shop.com>'],
    ['in-reply-to', '<sent-1@jointprintingshop.com>'],
    ['references', '<sent-1@jointprintingshop.com>'],
    ['list-unsubscribe', '<mailto:x@shop.com>'],
  ]);
  const raw = toRaw({
    envelope: {
      from: [{ address: 'Owner@GreenLeaf.com', name: 'Sam Rivera' }],
      subject: 'Re: merch for Green Leaf',
      messageId: '<abc123@shop.com>',
      date: new Date('2026-07-28T12:00:00Z'),
    },
    headers,
    bodyText: 'Yes — send pricing for 50 hoodies.',
  });
  assert.equal(raw.fromEmail, 'owner@greenleaf.com');   // normalized
  assert.equal(raw.fromName, 'Sam Rivera');
  assert.equal(raw.subject, 'Re: merch for Green Leaf');
  assert.equal(raw.snippet, 'Yes — send pricing for 50 hoodies.');
  assert.equal(raw.inReplyTo, '<sent-1@jointprintingshop.com>');
  // Headers must survive: the classifier reads the RFC auto/bulk signals.
  assert.equal(raw.headers['list-unsubscribe'], '<mailto:x@shop.com>');
  // The RFC Message-ID is the dedupe key, so a re-fetch can't double-store.
  assert.equal(raw.gmailMessageId, 'imap:<abc123@shop.com>');
});

test('toRaw survives a message missing everything', () => {
  const raw = toRaw({});
  assert.equal(raw.fromEmail, '');
  assert.equal(raw.subject, '');
  assert.equal(raw.snippet, '');
  assert.equal(raw.gmailMessageId, null);   // nothing stable to dedupe on
  assert.doesNotThrow(() => toRaw({ envelope: { from: [] }, headers: null }));
});

test('two fetches of one message produce the same dedupe key', () => {
  const mk = () => toRaw({ envelope: { messageId: '<same@x.com>', from: [{ address: 'a@x.com' }] }, headers: new Map() });
  assert.equal(mk().gmailMessageId, mk().gmailMessageId);
});

test('flattenHeaders and addressOf handle the shapes imapflow returns', () => {
  assert.deepEqual(flattenHeaders(new Map([['a', 'b'], ['c', ['d', 'e']]])), { a: 'b', c: 'd, e' });
  assert.deepEqual(flattenHeaders(null), {});
  assert.deepEqual(addressOf([{ address: 'A@B.com', name: 'N' }]), { email: 'a@b.com', name: 'N' });
  assert.deepEqual(addressOf([]), { email: '', name: '' });
  assert.deepEqual(addressOf(null), { email: '', name: '' });
});

// ── Never explodes a cron tick ───────────────────────────────────────────────

test('runImapSync is a silent no-op when unconfigured', async () => {
  const { runImapSync } = require('../replyImap');
  const r = await runImapSync({ env: {}, ingestOne: async () => ({}) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-configured');
  assert.equal(r.imported, 0);
});
