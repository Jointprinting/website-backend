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
const { simpleParser } = require('mailparser');

// Host is derived from the SMTP host so a provider swap doesn't need a second
// env var; IMAP_HOST overrides when a provider's names don't pair up.
const IMAP_HOST_BY_SMTP = [
  [/(^|\.)gmail\.com$|(^|\.)googlemail\.com$/i, 'imap.gmail.com'],
  [/(^|\.)office365\.com$|(^|\.)outlook\.com$/i, 'outlook.office365.com'],
  [/(^|\.)zoho\.com$/i, 'imap.zoho.com'],
  // Send-only relays: they accept mail for delivery and host NO mailbox, so
  // there is nothing to read and connecting is a guaranteed failure on a loop.
  [/(^|\.)resend\.com$/i, ''],
  [/(^|\.)sendpulse\.com$/i, ''],
  [/(^|\.)sendgrid\.net$/i, ''],
  [/(^|\.)brevo\.com$|(^|\.)sendinblue\.com$/i, ''],
  [/(^|\.)mailersend\.net$/i, ''],
  [/(^|\.)mailjet\.com$/i, ''],
  [/(^|\.)postmarkapp\.com$/i, ''],
  [/(^|\.)mailgun\.org$|(^|\.)mailgun\.com$/i, ''],
  [/(^|\.)amazonaws\.com$/i, ''],    // SES
  [/(^|\.)sparkpostmail\.com$/i, ''],
  [/(^|\.)socketlabs\.com$/i, ''],
  [/(^|\.)elasticemail\.com$/i, ''],
  [/(^|\.)smtp2go\.com$/i, ''],
];

// A relay's SMTP *username* is usually a service login, not a mailbox: Resend
// uses the literal "resend", SendGrid "apikey", Mailgun a postmaster@ robot.
// Treating one of those as an inbox is how the Studio ended up reporting that it
// "reads resend". Only a real address can name a mailbox.
const RE_ADDRESS = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const RELAY_USERNAMES = new Set(['resend', 'apikey', 'api', 'token', 'user', 'smtp']);

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
  // The username must actually BE a mailbox. A relay login ("resend", "apikey")
  // names no inbox, and guessing a host for it produced a connection that failed
  // on a ten-minute loop while the Studio reported it as the mailbox being read.
  if (!RE_ADDRESS.test(user) || RELAY_USERNAMES.has(user.toLowerCase())) return null;
  const host = String(env.IMAP_HOST || '').trim() || imapHostFor(env.SMTP_HOST);
  if (!host) return null;                       // send-only relay — nothing to read
  const port = Number(env.IMAP_PORT || 993) || 993;
  return { host, port, secure: port === 993, auth: { user, pass } };
}

// Where a reply can actually be sitting. Names differ by provider; a mailbox
// that isn't there is skipped.
//
// INBOX and Spam are the obvious ones (cold-email replies land in Spam
// routinely). The others exist because a message that has been ARCHIVED or
// deleted has LEFT the inbox — a filter, a phone swipe, or a quick tidy is
// enough — and a reply we never saw is indistinguishable from a reply that was
// never sent. All Mail also holds every message we SEND, and at 40/day that
// would swamp the window, so those folders are scanned with our own outbound
// excluded.
const FOLDERS = [
  { name: 'INBOX' },
  { name: '[Gmail]/Spam' },
  { name: 'Junk' },
  { name: 'Junk Email' },
  { name: '[Gmail]/Trash' },
  { name: 'Trash' },
  { name: 'Deleted Items' },
  { name: '[Gmail]/All Mail', excludeSelf: true },
  { name: 'Archive', excludeSelf: true },
];

// ...and the other half of the conversation. Every folder above deliberately
// excludes our own outbound, so the loop could see a buyer write in and never
// see the owner ANSWER — which is why a reply he had already handled in Gmail
// sat in "needs a response" until he went and clicked it closed a second time.
// The system has no way to tell "waiting on me" from "waiting on them", so it
// showed everything, forever.
//
// These folders are read for exactly one fact: he replied to this company at
// this time. Envelope only — no bodies, no triage rows, so this costs nothing
// against the body budget and can never create a signal of its own.
const SENT_FOLDERS = ['[Gmail]/Sent Mail', 'Sent', 'Sent Items', 'Sent Messages', 'INBOX.Sent'];

// How far back into a folder each tick looks. This used to be 60, chosen when
// every message in the window was fully downloaded on every run — and 60 is not
// two weeks of a cold-sending mailbox. That box collects bounces and
// autoresponders by the dozen, so a real reply could be pushed past the window
// by machine mail before a sync ran and then never be looked at again, which is
// exactly the "I got an email that isn't showing up here" case. Now that the
// metadata pass drops already-stored messages BEFORE downloading a body, a wider
// window costs one cheap fetch and nothing else in steady state.
const MAX_PER_FOLDER = 300;
const LOOKBACK_DAYS = 14;

// A ceiling on how many message BODIES one sync run will download and MIME-parse,
// across all folders combined.
//
// Per-folder caps alone are not a memory bound. Nine folders at 300 apiece is
// 2,700 candidates, and on the first run after a new folder is added (All Mail
// especially, which holds every message the account has ever seen) essentially
// none of them are stored yet — so every one is a full download plus a
// simpleParser allocation, in a single burst, on a small instance. Steady state
// is a handful of new messages a tick; only the catch-up burst is dangerous, and
// this bounds it. Anything not reached this tick is reached on the next one ten
// minutes later, so nothing is lost — it just arrives over a few ticks instead
// of all at once.
const MAX_BODIES_PER_RUN = 120;

/**
 * Flatten a header collection into the plain { name: value } ingestOne wants.
 *
 * Accepts a real Map (what mailparser returns) OR a raw RFC-822 header Buffer,
 * which is what imapflow actually hands back — its own typedef says
 * `{Buffer} [headers]`. A Buffer is a Uint8Array, so it HAS .forEach and the
 * previous version iterated BYTES: 112 entries keyed '0','1','2'… and every
 * real lookup undefined. That silently killed thread matching (In-Reply-To /
 * References were always '') and every RFC auto/bulk signal on the primary
 * reader, and the unit test passed only because it fed a Map, which production
 * never sees. Continuation lines are unfolded per RFC 5322. Pure.
 */
function flattenHeaders(src) {
  const out = {};
  if (!src) return out;
  if (Buffer.isBuffer(src) || typeof src === 'string') {
    const lines = String(src).replace(/\r\n/g, '\n').split('\n');
    let name = '';
    for (const line of lines) {
      if (!line.trim()) continue;
      if (/^[ \t]/.test(line) && name) {            // folded continuation
        out[name] += ` ${line.trim()}`;
        continue;
      }
      const idx = line.indexOf(':');
      if (idx <= 0) continue;
      name = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      out[name] = out[name] ? `${out[name]}, ${value}` : value;
    }
    return out;
  }
  if (typeof src.forEach !== 'function') return out;
  src.forEach((value, key) => {
    out[String(key).toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value == null ? '' : value);
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

// HTML entities, decoded once for every path.
//
// This has to run on the PLAIN part too, not just on HTML. Plenty of clients
// send a text/plain alternative that was generated from the HTML and still
// carries the escapes, which is how "Yes I'll get all the information over to
// you" reached the Studio as "Yes I&#39;ll get all the information over to you".
// The card renders text, so the entity showed through verbatim.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–',
  hellip: '…', middot: '·', bull: '•', trade: '™', copy: '©', reg: '®', deg: '°',
};
function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const hit = NAMED_ENTITIES[String(name).toLowerCase()];
      return hit === undefined ? m : hit;                 // unknown → leave as-is
    });
}
function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try { return String.fromCodePoint(n); } catch { return ''; }
}

/** Crude HTML → text, for the minority of replies sent as HTML only. Pure. */
function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')      // tags left spaces around every line break
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The readable body of a parsed message: what the person typed, decoded.
 *
 * mailparser hands back `text` when a text/plain part exists and `html`
 * otherwise; a couple of senders give us neither, in which case textAsHtml is
 * all there is. Pure.
 */
function bodyTextOf(parsed) {
  if (!parsed) return '';
  const plain = String(parsed.text || '').trim();
  if (plain) return decodeEntities(plain);
  return htmlToText(parsed.html || parsed.textAsHtml || '');
}

/** First text/plain (else text/html) leaf in a bodyStructure tree, or ''. Pure. */
function textPartPath(node) {
  if (!node) return '';
  const walk = (n, want) => {
    if (!n) return '';
    const type = String(n.type || '').toLowerCase();
    if (Array.isArray(n.childNodes) && n.childNodes.length) {
      for (const child of n.childNodes) {
        const hit = walk(child, want);
        if (hit) return hit;
      }
      return '';
    }
    // A leaf. Attachments announce themselves; never mistake one for the body.
    if (String(n.disposition || '').toLowerCase() === 'attachment') return '';
    return type === want ? String(n.part || '1') : '';
  };
  return walk(node, 'text/plain') || walk(node, 'text/html');
}

/** Read a decoded single part off the server (imapflow undoes base64/QP). */
async function downloadPart(client, uid, part) {
  const dl = await client.download(uid, part, { uid: true });
  if (!dl || !dl.content) return '';
  const chunks = [];
  for await (const chunk of dl.content) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  const isHtml = /html/i.test(String((dl.meta && dl.meta.contentType) || ''));
  return isHtml ? htmlToText(text) : text;
}

// Messages are pulled in two passes. The first asks only for metadata — cheap,
// no bodies — so we can drop the ones already stored WITHOUT paying to download
// them again. That matters: the folder scan looks back two weeks on a ten-minute
// cron, so the same replies were being re-fetched ~140 times each before the
// dedupe in ingestOne threw them away.
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;   // above this, pull only the text part

async function fetchFolder(client, folder, since, ingest, stats, seen) {
  const name = typeof folder === 'string' ? folder : folder.name;
  let lock;
  try {
    lock = await client.getMailboxLock(name);
  } catch {
    return;                                    // folder doesn't exist here
  }
  try {
    // In the everything-folders, skip our own outbound — otherwise 40 sends a
    // day fill the window and push the actual replies out of it.
    const query = { since };
    if (folder && folder.excludeSelf && stats.mailbox) query.not = { from: stats.mailbox };
    const uids = await client.search(query, { uid: true });
    if (!uids || !uids.length) return;
    const recent = uids.slice(-MAX_PER_FOLDER);

    // Pass 1 — metadata only. Deliberately WITHOUT headers: the envelope already
    // carries the message-id we dedupe on, and full headers on 300 messages is
    // real bandwidth for data we'd throw away. Messages we go on to ingest get
    // their headers from the parsed source; the rare fallback path fetches them.
    const heads = [];
    for await (const msg of client.fetch(
      recent,
      { uid: true, envelope: true, bodyStructure: true, size: true, internalDate: true },
      { uid: true },
    )) heads.push(msg);
    if (!heads.length) return;

    const already = await seen(heads.map((m) => String((m.envelope && m.envelope.messageId) || '').trim()).filter(Boolean));
    stats.scanned += heads.length;

    let fresh = heads.filter((m) => {
      const id = String((m.envelope && m.envelope.messageId) || '').trim();
      if (id && already.has(id)) { stats.skipped++; return false; }
      return true;
    });
    if (!fresh.length) return;

    // Spend the run's body budget oldest-first, so a backlog drains in arrival
    // order instead of the newest message starving the ones behind it.
    const budget = Math.max(0, MAX_BODIES_PER_RUN - stats.bodies);
    if (fresh.length > budget) {
      stats.deferred += fresh.length - budget;
      fresh = fresh.slice(0, budget);
    }
    if (!fresh.length) return;
    stats.bodies += fresh.length;

    // One message at a time, so peak memory is one message and not the folder.
    const handle = async (meta, source) => {
      try {
        let bodyText = '';
        let headers = meta.headers;
        if (source) {
          // Whole message → mailparser. It undoes MIME: multipart boundaries,
          // base64 / quoted-printable, charsets. Feeding the classifier the RAW
          // body instead (which is all BODY[TEXT] returns) meant an ordinary
          // quoted-printable reply arrived as boundary markers and "=E2=80=99"
          // escapes — so a buyer asking for pricing read as noise, got filed
          // bounce_auto_ignore, and never reached the worklist.
          const parsed = await simpleParser(source, { skipImageLinks: true });
          bodyText = bodyTextOf(parsed);
          if (Array.isArray(parsed.headerLines) && parsed.headerLines.length) {
            headers = parsed.headerLines.map((h) => h.line).join('\r\n');
          }
        }
        if (!bodyText) {
          // Oversized (someone attached their whole logo pack), or a message
          // mailparser found no body in: pull just the text part, decoded, and
          // leave the attachments on the server. A text-only read beats a
          // missed lead. Headers come along on this path — thread matching and
          // the RFC auto/bulk signals are read off them.
          const part = textPartPath(meta.bodyStructure);
          if (part) bodyText = await downloadPart(client, meta.uid, part).catch(() => '');
          if (!headers) {
            const one = await client.fetchOne(meta.uid, { headers: true }, { uid: true }).catch(() => null);
            if (one && one.headers) headers = one.headers;
          }
        }
        const res = await ingest(toRaw({ ...meta, headers, bodyText }));
        if (res && res.skip) stats.skipped++;
        else stats.imported++;
      } catch (e) {
        // One malformed message must never abort the run — count it so a broken
        // ingest is distinguishable from a quiet mailbox.
        stats.errors++;
        if (stats.errors <= 3) console.warn('[reply-imap] message failed:', e.message);
      }
    };

    const byUid = new Map(fresh.map((m) => [m.uid, m]));
    const normal = fresh.filter((m) => Number(m.size || 0) <= MAX_SOURCE_BYTES).map((m) => m.uid);
    if (normal.length) {
      for await (const msg of client.fetch(normal, { uid: true, source: true }, { uid: true })) {
        await handle(byUid.get(msg.uid) || msg, msg.source);
        byUid.delete(msg.uid);
      }
    }
    for (const meta of byUid.values()) await handle(meta, null);   // oversized / not returned
  } finally {
    try { lock.release(); } catch { /* already released */ }
  }
}

// Scan one Sent folder for messages the owner sent, and hand each one's
// (recipients, subject, thread refs, when) to the closer. Envelope-only: the
// answer's TEXT is his business, we only need to know that it happened.
//
// Only the FIRST folder that exists is scanned — Gmail exposes the same message
// under '[Gmail]/Sent Mail' and possibly an alias, and closing the same
// conversation twice is wasted work.
async function fetchSentFolder(client, name, since, onOwnReply, stats) {
  let lock;
  try {
    lock = await client.getMailboxLock(name);
  } catch {
    return false;                              // folder doesn't exist here
  }
  try {
    const query = { since };
    if (stats.mailbox) query.from = stats.mailbox;   // his, not a shared alias's
    const uids = await client.search(query, { uid: true });
    if (!uids || !uids.length) return true;
    const recent = uids.slice(-MAX_PER_FOLDER);
    for await (const msg of client.fetch(recent, { uid: true, envelope: true }, { uid: true })) {
      const env = msg.envelope || {};
      const to = [...(env.to || []), ...(env.cc || [])]
        .map((a) => String((a && a.address) || '').trim().toLowerCase()).filter(Boolean);
      if (!to.length) continue;
      stats.sentScanned += 1;
      try {
        const closed = await onOwnReply({
          toEmails: to,
          subject: env.subject || '',
          // The thread spine. inReplyTo is the direct parent; the envelope's
          // messageId is ours and deliberately not passed — matching on it would
          // resolve every send to itself.
          messageIds: [env.inReplyTo, ...(env.references || [])].filter(Boolean),
          sentAt: env.date || msg.internalDate || new Date(),
        });
        stats.closed += Number(closed) || 0;
      } catch (e) {
        stats.errors += 1;
        console.warn('[reply-imap] own-reply close failed:', e.message);
      }
    }
    return true;
  } catch (e) {
    console.warn(`[reply-imap] sent scan failed for ${name}:`, e.message);
    return true;                               // the folder existed; don't fall through
  } finally {
    try { lock.release(); } catch { /* already released */ }
  }
}

/**
 * Which of these RFC Message-IDs are already stored AND readable? Used to skip a
 * download.
 *
 * A row whose stored text is raw MIME does NOT count as seen: those were filed
 * on gibberish by the pre-decode reader, and letting them count would mean the
 * one mailbox that can repair them never fetches them again. Fetching such a
 * message a second time hands ingestOne a decoded copy, which rewrites the row
 * in place. Defaults to the triage collection; injectable so the reader stays
 * testable.
 */
async function seenMessageIds(ids = []) {
  if (!ids.length) return new Set();
  try {
    const TriageReply = require('../models/TriageReply');
    const { looksUndecoded, hasHtmlEntities } = require('./replyTriage');
    const rows = await TriageReply.find({ gmailMessageId: { $in: ids.map((id) => `imap:${id}`) } })
      .select('gmailMessageId snippet').lean();
    return new Set(rows
      .filter((r) => !looksUndecoded(r.snippet) && !hasHtmlEntities(r.snippet))
      .map((r) => String(r.gmailMessageId).replace(/^imap:/, '')));
  } catch {
    return new Set();                          // never block a sync on a lookup
  }
}

/**
 * Pull recent mail from the sending mailbox and run it through triage.
 * Returns a stats object; never throws.
 */
async function runImapSync({ env = process.env, ingestOne, onOwnReply, lookbackDays = LOOKBACK_DAYS, seen = seenMessageIds } = {}) {
  const cfg = imapConfig(env);
  if (!cfg) return { ok: false, reason: 'not-configured', scanned: 0, imported: 0, skipped: 0, errors: 0 };
  const ingest = ingestOne || require('../controllers/replyTriage').ingestOne;
  const closeOwn = onOwnReply || require('../controllers/replyTriage').closeOnOwnReply;

  const stats = { ok: true, mailbox: cfg.auth.user, scanned: 0, imported: 0, skipped: 0, errors: 0, bodies: 0, deferred: 0, sentScanned: 0, closed: 0 };
  const since = new Date(Date.now() - Math.max(1, lookbackDays) * 86400000);
  const client = new ImapFlow({ ...cfg, logger: false, emitLogs: false });

  try {
    await client.connect();
    for (const folder of FOLDERS) await fetchFolder(client, folder, since, ingest, stats, seen);
    // Then the owner's own answers, so anything he has already handled in Gmail
    // stops asking him to handle it again. Last, and never fatal: a mailbox with
    // no readable Sent folder still gets a full inbound sync.
    for (const name of SENT_FOLDERS) {
      if (await fetchSentFolder(client, name, since, closeOwn, stats)) break;
    }
  } catch (e) {
    console.warn('[reply-imap] sync failed:', e.message);
    return { ...stats, ok: false, reason: e.message };
  } finally {
    try { await client.logout(); } catch { /* connection already gone */ }
  }
  if (stats.imported) console.log(`[reply-imap] ${stats.imported} new repl${stats.imported === 1 ? 'y' : 'ies'} from ${stats.mailbox} (${stats.scanned} scanned)`);
  if (stats.deferred) console.log(`[reply-imap] ${stats.deferred} message(s) deferred to the next run (body budget ${MAX_BODIES_PER_RUN})`);
  if (stats.closed) console.log(`[reply-imap] ${stats.closed} worklist row(s) closed — the owner had already answered in Gmail`);
  return stats;
}

/** The mailbox this reader watches — '' when it isn't configured. Pure. */
function imapMailbox(env = process.env) {
  const cfg = imapConfig(env);
  return cfg ? cfg.auth.user : '';
}

module.exports = {
  runImapSync, imapConfig, imapHostFor, imapMailbox, toRaw, flattenHeaders, addressOf,
  htmlToText, bodyTextOf, textPartPath, seenMessageIds,
};
