// services/replyImap.js
//
// Reads the COLD-SENDING mailbox over IMAP so replies show up in the Studio
// without the owner connecting anything.
//
// Why this exists: cold mail goes out From (and Reply-To) a dedicated sending
// mailbox, deliberately kept off the owner's real inbox so cold volume, its
// bounces and its opt-outs never touch the main domain. That is the right
// setup — but it meant replies landed somewhere the Studio couldn't see. The
// Gmail-API sync (controllers/replyTriage) authenticates to whatever account
// owns GMAIL_REFRESH_TOKEN, which is a SEPARATE, hand-wired OAuth grant; when
// it points at a different mailbox, the reply counter reads an inbox the
// campaign never writes to and "0 replies" means "not measured".
//
// The fix avoids new setup entirely: the engine ALREADY holds working
// credentials for the sending mailbox (SMTP_USER / SMTP_PASS — a Google
// app password), and the same credentials authenticate IMAP. So we read the
// mailbox we send from, with what we already have. No OAuth, no new secret, no
// forwarding rule.
//
// Everything funnels into controllers/replyTriage.ingestOne — the same
// classifier, matcher, dedupe and side effects the Gmail path uses. This module
// only fetches and shapes; it decides nothing about what a message means.
//
// Safety: a no-op unless credentials exist, bounded work per run, and it never
// throws into the caller (a cron tick must not die because a mail server
// hiccuped).

const { ImapFlow } = require('imapflow');

// Host is derived from the SMTP host so a provider swap doesn't need a second
// env var; IMAP_HOST overrides when a provider's names don't pair up.
const IMAP_HOST_BY_SMTP = [
  [/(^|\.)gmail\.com$|(^|\.)googlemail\.com$/i, 'imap.gmail.com'],
  [/(^|\.)office365\.com$|(^|\.)outlook\.com$/i, 'outlook.office365.com'],
  [/(^|\.)zoho\.com$/i, 'imap.zoho.com'],
  [/(^|\.)sendpulse\.com$/i, ''],   // relay-only: no mailbox to read
  [/(^|\.)sendgrid\.net$/i, ''],
  [/(^|\.)brevo\.com$|(^|\.)sendinblue\.com$/i, ''],
  [/(^|\.)mailersend\.net$/i, ''],
  [/(^|\.)mailjet\.com$/i, ''],
];

/** Which IMAP host serves the mailbox behind this SMTP host? '' = none. Pure. */
function imapHostFor(smtpHost) {
  const h = String(smtpHost || '').trim().toLowerCase();
  if (!h) return '';
  for (const [re, imap] of IMAP_HOST_BY_SMTP) if (re.test(h)) return imap;
  // Unknown provider: the imap.<domain> convention is right often enough to try,
  // and a failed connection is logged and harmless.
  const parts = h.replace(/^(smtp|mail|relay)[.-]/, '');
  return parts ? `imap.${parts}` : '';
}

/** Resolved IMAP config, or null when we shouldn't/can't read a mailbox. Pure. */
function imapConfig(env = process.env) {
  if (String(env.OUTREACH_IMAP || '').toLowerCase() === 'off') return null;
  const user = String(env.IMAP_USER || env.SMTP_USER || '').trim();
  const pass = String(env.IMAP_PASS || env.SMTP_PASS || '').trim();
  if (!user || !pass) return null;
  const host = String(env.IMAP_HOST || '').trim() || imapHostFor(env.SMTP_HOST);
  if (!host) return null;                       // send-only relay — nothing to read
  const port = Number(env.IMAP_PORT || 993) || 993;
  return { host, port, secure: port === 993, auth: { user, pass } };
}

// Gmail keeps spam out of INBOX and cold-email replies land there routinely, so
// both are read. Names differ by provider; a mailbox that isn't there is skipped.
const FOLDERS = ['INBOX', '[Gmail]/Spam', 'Junk', 'Junk Email'];

const MAX_PER_FOLDER = 60;      // bounded work per tick
const LOOKBACK_DAYS = 14;

/** Flatten imapflow's header map into the plain {name: value} ingestOne wants. */
function flattenHeaders(map) {
  const out = {};
  if (!map || typeof map.forEach !== 'function') return out;
  map.forEach((value, key) => {
    out[String(key)] = Array.isArray(value) ? value.join(', ') : String(value == null ? '' : value);
  });
  return out;
}

/** An envelope address → { email, name }. Pure. */
function addressOf(list) {
  const a = Array.isArray(list) ? list[0] : null;
  return { email: String((a && a.address) || '').trim().toLowerCase(), name: String((a && a.name) || '').trim() };
}

/** Shape one fetched message into the raw form ingestOne expects. Pure. */
function toRaw(msg) {
  const env = msg.envelope || {};
  const { email, name } = addressOf(env.from);
  const headers = flattenHeaders(msg.headers);
  // The RFC Message-ID is stable across folders and re-fetches, so it doubles as
  // the dedupe key — ingestOne already refuses a second row for the same id.
  const messageId = String(env.messageId || headers['message-id'] || '').trim();
  const body = String(msg.bodyText || '').trim();
  return {
    fromEmail: email,
    fromName: name,
    subject: String(env.subject || '').trim(),
    snippet: body,
    headers,
    gmailMessageId: messageId ? `imap:${messageId}` : null,
    messageId,
    inReplyTo: headers['in-reply-to'] || '',
    references: headers.references || '',
    receivedAt: env.date || msg.internalDate || null,
  };
}

// Only the plain-text part is needed — the classifier reads words, and pulling
// full HTML bodies off a mail server every 10 minutes is wasted bandwidth.
async function fetchFolder(client, folder, since, ingest, stats) {
  let lock;
  try {
    lock = await client.getMailboxLock(folder);
  } catch {
    return;                                    // folder doesn't exist here
  }
  try {
    const uids = await client.search({ since }, { uid: true });
    if (!uids || !uids.length) return;
    const recent = uids.slice(-MAX_PER_FOLDER);
    for await (const msg of client.fetch(
      recent,
      { uid: true, envelope: true, headers: true, bodyParts: ['text'], internalDate: true },
      { uid: true },
    )) {
      stats.scanned++;
      try {
        const part = msg.bodyParts && msg.bodyParts.get('text');
        const raw = toRaw({ ...msg, bodyText: part ? part.toString('utf8') : '' });
        const res = await ingest(raw);
        if (res && res.skip) stats.skipped++;
        else stats.imported++;
      } catch (e) {
        // One malformed message must never abort the run — count it so a broken
        // ingest is distinguishable from a quiet mailbox.
        stats.errors++;
        if (stats.errors <= 3) console.warn('[reply-imap] message failed:', e.message);
      }
    }
  } finally {
    try { lock.release(); } catch { /* already released */ }
  }
}

/**
 * Pull recent mail from the sending mailbox and run it through triage.
 * Returns a stats object; never throws.
 */
async function runImapSync({ env = process.env, ingestOne, lookbackDays = LOOKBACK_DAYS } = {}) {
  const cfg = imapConfig(env);
  if (!cfg) return { ok: false, reason: 'not-configured', scanned: 0, imported: 0, skipped: 0, errors: 0 };
  const ingest = ingestOne || require('../controllers/replyTriage').ingestOne;

  const stats = { ok: true, mailbox: cfg.auth.user, scanned: 0, imported: 0, skipped: 0, errors: 0 };
  const since = new Date(Date.now() - Math.max(1, lookbackDays) * 86400000);
  const client = new ImapFlow({ ...cfg, logger: false, emitLogs: false });

  try {
    await client.connect();
    for (const folder of FOLDERS) await fetchFolder(client, folder, since, ingest, stats);
  } catch (e) {
    console.warn('[reply-imap] sync failed:', e.message);
    return { ...stats, ok: false, reason: e.message };
  } finally {
    try { await client.logout(); } catch { /* connection already gone */ }
  }
  if (stats.imported) console.log(`[reply-imap] ${stats.imported} new repl${stats.imported === 1 ? 'y' : 'ies'} from ${stats.mailbox} (${stats.scanned} scanned)`);
  return stats;
}

/** The mailbox this reader watches — '' when it isn't configured. Pure. */
function imapMailbox(env = process.env) {
  const cfg = imapConfig(env);
  return cfg ? cfg.auth.user : '';
}

module.exports = { runImapSync, imapConfig, imapHostFor, imapMailbox, toRaw, flattenHeaders, addressOf };
