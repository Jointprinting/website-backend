// controllers/replyTriage.js
//
// Gmail Reply Triage V1 — a small, detection-only inbox for buyer replies to cold
// outreach. It classifies each reply (services/replyTriage.js), matches it to an
// existing outreach lead by email/subject, and lets the owner triage it. It never
// sends email and never auto-migrates a lead into the order flow. The only CRM
// write it makes is the safe, already-established one: a "do not contact" flips the
// company's existing doNotEmail flag and stops its active sequences — the same
// thing the public unsubscribe + bounce paths already do.

const cron = require('node-cron');
const TriageReply = require('../models/TriageReply');
const OutreachEnrollment = require('../models/OutreachEnrollment');
const OutreachState = require('../models/OutreachState');
const Client = require('../models/Client');
const {
  classifyReply,
  stripQuotedReply,
  looksUndecoded,
  needsTextRepair,
  finalizeCategory,
  classifyBounceNdr,
  matchReply,
  parseOooResume,
  parseFromHeader,
  gmailQuery,
  suggestedActionFor,
  isValidStatus,
  normEmail,
  domainOf,
  FREEMAIL,
  STRONG_MATCHES,
  STATUSES,
  isGmailConfigured,
  worklistFromReplies,
} = require('../services/replyTriage');
const { warmFromEnrollment, closeWarm } = require('../services/warmHandoff');
const { suppress } = require('../services/suppression');
const { getSenders } = require('../services/senderPool');

const IGNORE_CATEGORY = 'bounce_auto_ignore';
const VALID_SOURCES = ['manual', 'import', 'gmail'];

// Categories that mean "a real human replied" — auto-stop the drip + warm the
// CRM (on a STRONG match). Kill/soft/noise categories are handled separately.
const HUMAN_WARM = new Set(['hot_lead', 'needs_response', 'asked_pricing', 'asked_mockups', 'follow_up_later']);

// Pull thread-id headers (In-Reply-To / References) out of a raw reply, however
// it was handed in (top-level fields or a headers map). Used to match a reply to
// the exact send it answers even when it comes from a different address.
function messageIdsFromRaw(raw = {}) {
  const ids = [];
  const push = (v) => String(v || '').split(/\s+/).forEach((x) => { const t = x.trim(); if (t) ids.push(t); });
  const h = raw.headers || {};
  push(raw.inReplyTo); push(raw.references);
  push(h['in-reply-to'] || h['In-Reply-To']);
  push(h.references || h.References);
  return [...new Set(ids)];
}

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Rewrite a row that was stored as raw MIME with the decoded text, and re-file
// it on what the person actually wrote.
//
// The status rule is the careful part. A row the MACHINE filed away (auto-ignore
// + 'new'/'ignored') goes back to 'new' so a real question resurfaces in the
// worklist — that is the entire point. A row the OWNER triaged keeps his
// decision: if he read it and said "not a lead", a better decode does not get to
// overrule him. Never touches matching or the enrollment; only the text, the
// category, and — when the machine was the one that was wrong — the status.
const MACHINE_FILED = new Set(['new', 'ignored']);
// Worth putting back in front of the owner. An out-of-office is a real mailbox
// that decoded fine — but it's still a machine and there is nothing to answer,
// so a repair doesn't resurface it (the sequence's own snooze handles it).
const PROMOTABLE = (category) => category !== IGNORE_CATEGORY && category !== 'auto_reply_ooo';
async function repairStoredReply(dup, { subject, body, snippet, fromEmail, fromName, headers }) {
  // Re-classify WITH the match we already stored. The fresh-ingest path
  // deliberately runs the classifier a second time carrying match context,
  // because shops hosted on Shopify/Dutchie/Square stamp List-Unsubscribe and
  // friends on ordinary 1:1 mail — and that second pass is the only thing that
  // rescues a genuine buyer reply from the bulk-header veto. Repairing without
  // it re-ran the veto with nothing to overrule it, so a reply that had already
  // been rescued got re-buried as machine noise on its way through a text fix.
  // Those HTML-sending clients are exactly the ones producing the entity rows
  // this repair path targets, so it was the common case, not the corner.
  const cls = classifyReply({
    subject, snippet: body, fromEmail, fromName, headers,
    matched: !!dup.matched, matchBy: dup.matchBy || '',
  });
  const fin = finalizeCategory({ category: cls.category, matched: !!dup.matched, subject, snippet: body });
  const category = fin.category;

  const set = { snippet, category, suggestedAction: suggestedActionFor(category) };
  const wasMachineFiled = dup.category === IGNORE_CATEGORY && MACHINE_FILED.has(dup.status);
  if (wasMachineFiled && PROMOTABLE(category)) {
    set.status = 'new';
    set.handledAt = null;
  }
  await TriageReply.updateOne({ _id: dup._id }, { $set: set });
  const promoted = !!set.status;
  if (promoted) {
    console.log(`[triage] repaired a mis-decoded reply from ${fromEmail || '(no sender)'} → ${category}`);
  }

  // Close the loop the repair just opened. Decoding a row can reveal an opt-out
  // that nobody could read before — and rewriting the category alone left it
  // filed as 'unsubscribe' with the address never suppressed and the company
  // never flagged, so the next campaign would mail them again. Reading a stated
  // opt-out and then not honoring it is worse than never having decoded it.
  // Only the KILL categories act here: a repaired lead is surfaced for the owner
  // rather than auto-warmed, since the warm handoff already ran (or didn't) when
  // the row was first ingested.
  if (category === 'unsubscribe' || category === 'not_interested') {
    try {
      await applyReplyAutoActions(
        { ...dup, ...set, fromEmail, companyKey: dup.companyKey, enrollmentId: dup.enrollmentId },
        cls,
        {
          matched: !!dup.matched,
          matchBy: dup.matchBy || '',
          companyKey: dup.companyKey || '',
          enrollmentId: dup.enrollmentId || null,
        },
      );
    } catch (e) {
      console.warn('[triage] repair auto-action failed:', e.message);
    }
  }
  return { repaired: true, promoted, category };
}

// ── The owner answered: take it off his list ─────────────────────────────────
//
// A worklist row is a question waiting on HIM. Until now the only way for one to
// stop asking was for him to go and click it closed — so every conversation he
// had already answered in Gmail kept sitting in "needs a response", and every
// further message in a live back-and-forth arrived as a fresh signal about a
// deal he was visibly already working.
//
// The rule this collapses to is just: THE BALL IS IN WHOSEVER COURT SPOKE LAST.
// They wrote last → it's on his list. He wrote last → it isn't. Nothing to mark,
// nothing to remember, and it re-opens by itself the moment they write back,
// which is exactly when he wants to know.
//
// Only `new` rows are closed. quote_requested / mockup_requested / follow_up are
// states HE set to track his own work — a quote isn't delivered because he sent
// a message — so they stay until he clears them.
//
// `receivedAt < sentAt` is the whole safety property: a message that arrived
// AFTER his answer is a genuinely new ball in his court and must survive. Called
// once per sent message by the IMAP reader; returns how many rows it closed.
async function closeOnOwnReply(raw = {}) {
  const sentAt = raw.sentAt ? new Date(raw.sentAt) : new Date();
  if (!Number.isFinite(sentAt.getTime())) return 0;
  const subject = String(raw.subject || '').trim();
  const messageIds = (raw.messageIds || []).map((x) => String(x || '').trim()).filter(Boolean);
  const toEmails = [...new Set((raw.toEmails || [])
    .map((e) => normEmail(e)).filter(Boolean))];
  if (!toEmails.length && !messageIds.length) return 0;

  // Resolve the RECIPIENT to a company. matchReply is written from the buyer's
  // side, so handing it the address he wrote TO reuses the exact same
  // thread → email → subject → domain ladder, with the same confidence rules.
  const refVariants = [...new Set(messageIds.flatMap((id) => {
    const bare = String(id).replace(/[<>]/g, '').trim();
    return [id, bare, `<${bare}>`];
  }).filter(Boolean))];

  let closed = 0;
  const seenKeys = new Set();
  for (const to of (toEmails.length ? toEmails : [''])) {
    const dom = domainOf(to);
    const enrOr = [];
    if (to) enrOr.push({ toEmail: to });
    if (dom && !FREEMAIL.has(dom)) enrOr.push({ toEmail: new RegExp(`@${escapeRegex(dom)}$`, 'i') });
    if (refVariants.length) enrOr.push({ 'sends.messageId': { $in: refVariants } });
    if (!enrOr.length) continue;
    const enrollments = await OutreachEnrollment.find({ $or: enrOr })
      .select('companyKey companyName toEmail sends').limit(50).lean();
    const clients = to
      ? await Client.find({ $or: [{ email: to }, { 'contacts.email': to }] })
        .select('companyKey companyName email contacts').lean()
      : [];

    const match = matchReply(to, subject, {
      enrollments: enrollments.map((e) => ({
        ...e,
        subjects: (e.sends || []).map((s) => s.subject),
        messageIds: (e.sends || []).map((s) => s.messageId),
      })),
      clients,
      messageIds,
    });
    // A DOMAIN match is the soft one — same business, different mailbox. Good
    // enough to show a link, not good enough to silence an unread cold reply on
    // its own... but that bar is wrong for a thread he has demonstrably been
    // answering for weeks. The cold mail usually goes to info@ or hello@ and a
    // named buyer picks it up, so a domain match is the ONLY rung that fires,
    // and refusing it outright is what kept discarding the close.
    //
    // So: accept a domain match when something else already establishes this is
    // a live conversation with that company — a stored reply from them that was
    // matched some stronger way. That is real corroboration, not a guess.
    if (!match.matched || !match.companyKey) continue;
    if (match.matchBy === 'domain') {
      const corroborated = await TriageReply.exists({
        companyKey: match.companyKey,
        matchBy: { $in: [...STRONG_MATCHES] },
      }).catch(() => null);
      if (!corroborated) continue;
    }
    if (seenKeys.has(match.companyKey)) continue;   // one sent mail, one close
    seenKeys.add(match.companyKey);

    const r = await TriageReply.updateMany(
      { companyKey: match.companyKey, status: 'new', receivedAt: { $lt: sentAt } },
      { $set: { status: 'handled', handledAt: sentAt, handledBy: 'owner-reply' } },
    ).catch(() => ({ modifiedCount: 0 }));
    closed += r.modifiedCount || 0;
    // He answered them, so he is talking to them — the same fact his triage
    // click asserts, arrived at without the click. Recorded even when the
    // updateMany closed nothing (he may have replied before any row was filed).
    await markEngaged(match.companyKey, 'owner-reply').catch(() => {});
  }
  return closed;
}

// ── "I'm already talking to these people" ────────────────────────────────────
//
// The owner asked for this twice: the FIRST reply from a shop is news and should
// reach him; the twelfth message of a live negotiation is not. He was getting
// "needs a response" on message twelve of a deal he was actively working, which
// is noise pretending to be a signal.
//
// Engagement is per-COMPANY, not per-reply. A worklist row is per-reply, but
// collapseByCompany already folds a company down to one card, so "one company =
// one thing to do" is a decision this codebase made long ago.
//
// It is set by HIS action, never hers. Every existing "warm" marker
// (Client.lastContact, stage, the warm tag, enrollment.status 'replied') is
// written by warmCompany on the INBOUND message — they all go true the instant
// her first reply lands, so any of them would have silenced the one
// notification he explicitly asked to keep.
const QUIET_DAYS = parseInt(process.env.TRIAGE_QUIET_DAYS || '21', 10);
const DAY_MS = 86400000;

/**
 * Mark a company as one the owner is in conversation with. Idempotent — the
 * FIRST engagement wins, so re-engaging never moves the clock forward and can
 * never extend a silence into permanence. Never throws: this is bookkeeping
 * alongside the action the owner actually asked for.
 */
async function markEngaged(companyKey, by = 'triage') {
  const key = String(companyKey || '').trim();
  if (!key) return false;
  const r = await Client.updateOne(
    { companyKey: key, $or: [{ engagedAt: null }, { engagedAt: { $exists: false } }] },
    { $set: { engagedAt: new Date(), engagedBy: String(by).slice(0, 24) } },
  ).catch(() => ({ modifiedCount: 0 }));
  return !!r.modifiedCount;
}

/**
 * Is this incoming reply a SIGNAL, or just the next line of a conversation
 * already in flight? Returns the status the row should be born with.
 *
 * The quiet-gap rule is the part that protects revenue. Permanent engagement
 * would mean Apothecare going quiet for two months and then writing "ready to
 * order 500 hoodies" lands silently — and that hub row is the only automated
 * detector of inbound revenue in the whole system. A fixed expiry is just as
 * wrong: it re-opens a deal mid-negotiation on day 31 for no reason.
 *
 * So the clock is QUIET TIME, and it is only ever read when a message arrives:
 * her answer three days into a live thread stays quiet, her answer after two
 * months of silence is news again. Rebecca's case satisfied in both directions,
 * with no field beyond engagedAt.
 */
async function statusForIncoming(companyKey, receivedAt) {
  const key = String(companyKey || '').trim();
  if (!key) return 'new';                       // unmatched — always a signal
  const client = await Client.findOne({ companyKey: key })
    .select('engagedAt').lean().catch(() => null);
  const engagedAt = client && client.engagedAt ? new Date(client.engagedAt) : null;
  if (!engagedAt || !Number.isFinite(engagedAt.getTime())) return 'new';

  // Last time anything happened on this relationship: her most recent message,
  // or the moment he engaged, whichever is later.
  const last = await TriageReply.findOne({ companyKey: key })
    .sort({ receivedAt: -1 }).select('receivedAt').lean().catch(() => null);
  const lastAt = Math.max(
    engagedAt.getTime(),
    last && last.receivedAt ? new Date(last.receivedAt).getTime() : 0,
  );
  const at = receivedAt instanceof Date && Number.isFinite(receivedAt.getTime())
    ? receivedAt.getTime() : Date.now();
  if (at - lastAt > QUIET_DAYS * DAY_MS) {
    // Gone quiet long enough that this is new information again. Clearing the
    // stamp lets the row be born a signal through the ordinary path rather than
    // needing a special case at read time.
    await Client.updateOne({ companyKey: key }, { $set: { engagedAt: null, engagedBy: '' } })
      .catch(() => {});
    return 'new';
  }
  return 'in_conversation';
}

// Classify + match one raw reply and persist it. Own sent mail is dropped (not a
// reply); everything else — including bounces/auto-replies and unmatched senders —
// is stored so nothing silently disappears. Returns { saved, skip }.
async function ingestOne(raw = {}) {
  const fromEmail = normEmail(raw.fromEmail);
  const subject = String(raw.subject || '').trim();
  // CLASSIFY on the whole body, STORE a card-sized excerpt. Truncating first cut
  // the message at 600 chars — which lands mid-quote on any threaded reply, so a
  // bottom-posted "please take us off your list" or a pricing question below a
  // signature was cut off before the classifier ever saw it. The stored snippet
  // is only what the Studio card shows.
  const body = String(raw.snippet || raw.body || '').trim();
  const snippet = body.slice(0, 600);
  const fromName = String(raw.fromName || '').trim();

  if (!fromEmail && !subject && !snippet) return { skip: 'empty' };

  // Dedupe a re-synced message (manual rows carry no id) — EXCEPT when the row
  // we already have is unreadable. Replies synced before the reader learned to
  // decode MIME were stored as raw boundary markers and base64, so they were
  // filed on gibberish: the buyer asking for pricing is sitting in the database
  // as machine noise, and nothing could rescue it. Re-classifying can't (there
  // are no words to read) and re-ingesting couldn't (this check skipped it).
  // Now a properly decoded copy of a message we hold in raw form REPAIRS the row
  // in place instead of being thrown away.
  const gmailMessageId = raw.gmailMessageId ? String(raw.gmailMessageId) : null;
  if (gmailMessageId) {
    const dup = await TriageReply.findOne({ gmailMessageId })
      .select('_id snippet category status matched matchBy companyKey enrollmentId').lean();
    if (dup && !needsTextRepair(dup.snippet, body)) return { skip: 'duplicate' };
    if (dup) return repairStoredReply(dup, { subject, body, snippet, fromEmail, fromName, headers: raw.headers || null });
  }

  // Pass the raw header map through so classifyReply can use the RFC-standard
  // auto/bulk signals (Auto-Submitted / Precedence / X-Auto* / List-*), which are
  // far more reliable than subject/body wording for catching auto-responders.
  let cls = classifyReply({ subject, snippet: body, fromEmail, fromName, headers: raw.headers || null });
  if (cls.self) return { skip: 'self' }; // our own outbound mail is never a reply

  // Candidate matches (loaded here; matchReply itself is pure/testable). Beyond
  // "same sender address" we also pull enrollments the reply THREADS to (its
  // In-Reply-To/References vs a send's Message-ID) and enrollments on the same
  // BUSINESS domain — so a buyer replying from a personal/shared inbox still
  // matches instead of silently becoming UNMATCHED.
  const messageIds = messageIdsFromRaw(raw);
  const refVariants = [...new Set(messageIds.flatMap((id) => {
    const bare = String(id).replace(/[<>]/g, '').trim();
    return [id, bare, `<${bare}>`];
  }).filter(Boolean))];
  const dom = domainOf(fromEmail);

  let enrollments = [];
  let clients = [];
  const enrOr = [];
  if (fromEmail) enrOr.push({ toEmail: fromEmail });
  if (dom && !FREEMAIL.has(dom)) enrOr.push({ toEmail: new RegExp(`@${escapeRegex(dom)}$`, 'i') });
  if (refVariants.length) enrOr.push({ 'sends.messageId': { $in: refVariants } });
  if (enrOr.length) {
    enrollments = await OutreachEnrollment.find({ $or: enrOr })
      .select('companyKey companyName toEmail sends').limit(50).lean();
  }
  if (fromEmail) {
    clients = await Client.find({ $or: [{ email: fromEmail }, { 'contacts.email': fromEmail }] })
      .select('companyKey companyName email contacts').lean();
  }

  const match = matchReply(fromEmail, subject, {
    enrollments: enrollments.map((e) => ({
      ...e,
      subjects: (e.sends || []).map((s) => s.subject),
      messageIds: (e.sends || []).map((s) => s.messageId),
    })),
    clients,
    messageIds,
  });

  // Second look, now that the match is known. A message auto-ignored PURELY on a
  // bulk RFC header (List-Unsubscribe / Feedback-ID / X-Auto-Response-Suppress —
  // which Shopify/Dutchie/Square/helpdesk-hosted shops stamp on ordinary mail)
  // gets re-classified with that match context: threading back to a send of ours
  // is the strongest evidence a message can carry that it IS a real reply, so the
  // header becomes evidence instead of a veto. classifyReply still requires a
  // human/buying line in the sender's own (unquoted) words to flip it.
  if (cls.auto && cls.bulkHeader && match.matched) {
    const second = classifyReply({
      subject, snippet: body, fromEmail, fromName,
      headers: raw.headers || null,
      matched: true, matchBy: match.matchBy,
    });
    if (second.category !== cls.category) {
      console.log(`[triage] bulk-header override: ${fromEmail || '(no sender)'} matched by ${match.matchBy} → ${second.category}`);
      cls = second;
    }
  }

  // Post-match final say: unmatched + no buying signal + promotional shape is
  // machine mail (the Google Workspace "free trial is ending" class), never a
  // lead. Matched replies and anything with real intent pass through untouched.
  const fin = finalizeCategory({ category: cls.category, matched: match.matched, subject, snippet: body });
  const category = fin.category;
  if (fin.downgraded) { cls.category = category; cls.ignore = true; }

  const source = VALID_SOURCES.includes(raw.source) ? raw.source : 'manual';
  const receivedAt = raw.receivedAt ? new Date(raw.receivedAt) : new Date();

  const doc = await TriageReply.create({
    fromEmail,
    fromName,
    subject,
    snippet,
    receivedAt: isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
    category,
    suggestedAction: suggestedActionFor(category),
    // A message from a company he is already working is not a signal. Resolved
    // HERE, at birth, because the re-open he complained about was never in the
    // Sent-folder closer — it is that every reply was stamped 'new' with no
    // memory of the company, so Rebecca's message twelve was born byte-identical
    // to her message one.
    status: await statusForIncoming(match.companyKey, receivedAt),
    matched: match.matched,
    matchBy: match.matchBy,
    companyKey: match.companyKey,
    companyName: match.companyName,
    enrollmentId: match.enrollmentId || null,
    source,
    gmailMessageId,
  });

  // Close the loop: auto-stop / warm / suppress / snooze based on what they said.
  // Best-effort — a side-effect hiccup must not fail the ingest (row is saved).
  try {
    await applyReplyAutoActions(doc, cls, match);
  } catch (e) {
    console.warn('[triage] auto-action failed:', e.message);
  }

  return { saved: doc.toObject() };
}

// The loop-closing behavior for one just-ingested reply. THE fix: a matched
// human reply must stop the drip and warm the CRM instead of silently sitting in
// the inbox while the day-14 breakup keeps firing. Runs on manual/imported/synced
// replies alike (they all flow through ingestOne).
//   unsubscribe    → suppress the address + do-not-contact + stop sequences
//   not_interested → stop sequences (no warm — it's a "no")
//   auto_reply_ooo → snooze the enrollment ~7 days (keep active → it resumes)
//   human reply    → STRONG match only: stop the drip + warm the company (Today)
//   wrong_person / bounce / soft(domain) match → left for manual triage
async function applyReplyAutoActions(reply, cls, match) {
  const category = cls.category;
  const strong = STRONG_MATCHES.has(match.matchBy);

  if (category === 'unsubscribe') {
    // Address-level suppression fires always (even unmatched); the COMPANY-level
    // doNotEmail + sequence stop only on a STRONG match — never flip a whole shop
    // to do-not-contact off a soft same-domain guess (a shared/franchise inbox).
    await applyStatusSideEffects(reply, 'do_not_contact', { companyLevel: strong });
    return;
  }
  if (category === 'not_interested') {
    await applyStatusSideEffects(reply, 'not_interested', { companyLevel: strong });
    return;
  }
  if (category === IGNORE_CATEGORY) {
    // Not ALL machine mail is ignorable. Google Workspace SMTP reports dead
    // mailboxes as Delivery Status Notification EMAILS (not send-time errors),
    // so this inbox is the only place hard bounces are visible on Gmail SMTP.
    // Parse the failed recipient out of the NDR and run the same hard-bounce
    // path the provider webhook uses — suppress + stop + doNotEmail — so a dead
    // address never gets touches 2/3/4 and the circuit-breaker sees real data.
    // Soft failures (mailbox full, greylist) are left alone. Best-effort.
    await ingestNdrBounce(reply).catch((e) => console.warn('[triage] NDR bounce ingest failed:', e.message));
    return;
  }
  if (cls.ooo || category === 'auto_reply_ooo') {
    if (strong && match.enrollmentId) {
      const resumeAt = parseOooResume(reply.snippet, reply.receivedAt);
      await OutreachEnrollment.updateOne(
        { _id: match.enrollmentId, status: 'active' },
        { $set: { nextSendAt: resumeAt } },
      );
    }
    return;
  }
  // A genuine human reply — stop the drip + warm the CRM, but only on a strong
  // match (never auto-act on a soft same-domain guess).
  if (HUMAN_WARM.has(category) && strong && match.enrollmentId) {
    const enr = await OutreachEnrollment.findById(match.enrollmentId);
    if (enr) await warmFromEnrollment(enr, { source: 'triage' });
    return;
  }

  // SOFT match — someone at the company wrote to us from an address we didn't
  // mail, with a subject that doesn't thread back. We won't warm the CRM off
  // that (a shared or franchise inbox shouldn't move a whole shop's stage), but
  // we must not keep DRIPPING at them either: the reply is sitting in the
  // worklist while touch 2 goes out to the same business. Pausing is safe and
  // reversible in a way doNotEmail is not, so the two decisions are separated —
  // the sequence pauses, and the owner still decides what the reply means.
  if (HUMAN_WARM.has(category) && match.matched && match.companyKey) {
    const PAUSE_DAYS = 14;
    const until = new Date(Date.now() + PAUSE_DAYS * 86400000);
    const res = await OutreachEnrollment.updateMany(
      { companyKey: match.companyKey, status: 'active' },
      { $set: { nextSendAt: until } },
    ).catch(() => ({ modifiedCount: 0 }));
    if (res.modifiedCount) {
      console.log(`[triage] someone at ${match.companyKey} replied from another address — paused ${res.modifiedCount} sequence(s) pending triage`);
    }
  }
}

// Domains WE send/reply from — excluded when parsing failed recipients out of an
// NDR (our own addresses appear in the quoted original message).
function ourSendingDomains() {
  const doms = new Set();
  const add = (addr) => { const d = domainOf(addr); if (d) doms.add(d); };
  try { getSenders().forEach((s) => { add(s.from); add(s.replyTo); }); } catch { /* pool unavailable → env only */ }
  add(process.env.OUTREACH_EMAIL_FROM);
  add(process.env.OUTREACH_REPLY_TO);
  add(process.env.EMAIL_FROM);
  return [...doms];
}

// Turn a hard-bounce NDR into the exact suppression the provider webhook would
// have applied: address-level Suppression + stop active sequences + doNotEmail.
// GUARDED: only fires for addresses we actually emailed (a toEmail on some
// enrollment) — a random address quoted inside a forwarded NDR is never touched.
async function ingestNdrBounce(reply) {
  const ndr = classifyBounceNdr(reply, ourSendingDomains());
  if (!ndr.isBounce || !ndr.emails.length) return;

  // SOFT bounce ("temporary problem… will retry", mailbox full, deferred):
  // never kill the lead, but stop stacking more sends onto a struggling
  // mailbox — push the enrollment's next touch past the provider's retry
  // window and count the notice. Three notices ≈ the mailbox is dead in
  // practice → suppress the ADDRESS and fail the enrollment (no company-wide
  // doNotEmail: a different contact at the company may still be reachable).
  if (!ndr.hard) {
    if (!ndr.soft) return;
    const DEFER_MS = 72 * 60 * 60 * 1000;
    for (const email of ndr.emails) {
      const rx = new RegExp(`^${escapeRegex(email)}$`, 'i');
      const enrs = await OutreachEnrollment.find({ toEmail: rx, status: 'active' });
      for (const e of enrs) {
        e.softBounceCount = (e.softBounceCount || 0) + 1;
        e.lastSoftBounceAt = new Date();
        if (e.softBounceCount >= 3) {
          e.status = 'failed';
          e.stopReason = 'bounced';
          e.nextSendAt = null;
          await e.save();
          await suppress(email, { reason: 'soft-bounce-x3', source: 'gmail-ndr' });
          console.log(`[triage] 3rd soft bounce → suppressed ${email}, enrollment failed`);
        } else {
          const deferTo = new Date(Date.now() + DEFER_MS);
          if (!e.nextSendAt || e.nextSendAt < deferTo) e.nextSendAt = deferTo;
          await e.save();
          console.log(`[triage] soft bounce #${e.softBounceCount} for ${email} → next touch deferred 72h`);
        }
      }
    }
    return;
  }
  for (const email of ndr.emails) {
    const rx = new RegExp(`^${escapeRegex(email)}$`, 'i');
    const enrs = await OutreachEnrollment.find({ toEmail: rx }).select('companyKey status').lean();
    if (!enrs.length) continue; // not an address we ever sent to → leave it alone
    await suppress(email, { reason: 'hard-bounce', source: 'gmail-ndr' });
    const keys = new Set();
    for (const e of enrs) {
      keys.add(e.companyKey);
      if (e.status === 'active') {
        await OutreachEnrollment.updateOne(
          { _id: e._id, status: 'active' },
          { $set: { status: 'failed', stopReason: 'bounced', nextSendAt: null } },
        ).catch(() => {});
      }
    }
    // Retire the ADDRESS, never the company.
    //
    // This used to set doNotEmail on every company the dead address touched —
    // permanently retiring a real, licensed dispensary because one alias had
    // been deleted. A shop that publishes info@ and careers@ is one bad alias
    // away from being struck off the list forever, and since the write left no
    // log line the release healer could never undo it. The send path already
    // settled this policy: kill the address, keep the business. So the address
    // comes off the Client record instead, which also frees the enricher to go
    // find a working one on the next sweep.
    if (keys.size) {
      const rxEmail = new RegExp(`^${escapeRegex(email)}$`, 'i');
      await Client.updateMany(
        { companyKey: { $in: [...keys] }, email: rxEmail },
        { $unset: { email: '' } },
      ).catch(() => {});
      await Client.updateMany(
        { companyKey: { $in: [...keys] } },
        { $pull: { contacts: { email: rxEmail } } },
      ).catch(() => {});
    }
    console.log(`[triage] NDR hard bounce → retired ${email} across ${keys.size} compan${keys.size === 1 ? 'y' : 'ies'} (company kept)`);
  }
}

// One-time healer: re-run the (now header/wording-aware) classifier over replies
// that were ingested BEFORE the auto-responder fix and are still sitting in a
// human/actionable bucket. Any that are actually machine auto-acks (e.g. an
// "Auto response: …" caught by subject) are demoted to bounce_auto_ignore +
// status 'ignored', so they drop out of the triage worklist AND the hub banner
// without the owner touching anything. Idempotent; safe to re-run. Returns count.
const HUMANISH_CATEGORIES = ['hot_lead', 'needs_response', 'asked_pricing', 'asked_mockups', 'follow_up_later', 'wrong_person'];
/**
 * ONE-TIME: teach the existing data who he is already talking to.
 *
 * Without this the fix does nothing on day one — Apothecare's stored rows are
 * still status:'new', so the worklist, the hub alerts and the bridge bucket all
 * go on shouting about a deal he has been working for weeks, and he would have
 * to clear every one of them by hand. Exactly the chore he asked to stop doing.
 *
 * Engagement is inferred from evidence that ALREADY EXISTS and can only mean he
 * acted: a reply he triaged himself (any status the machine does not set), or a
 * company that produced a job. Deliberately NOT inferred from warm/lastContact/
 * stage/enrollment-'replied' — every one of those is written by warmCompany on
 * HER inbound message, so they would mark companies engaged that he has never
 * touched and swallow the first-reply notification he asked to keep.
 *
 * Then, for each engaged company, its still-'new' rows become 'in_conversation'
 * — the state they would have been born into. Returns what it changed.
 */
async function backfillEngagedConversations() {
  // Statuses only a human sets. 'new' is the machine default and 'ignored' is
  // written by the auto-classifier, so neither is evidence of him.
  const OWNER_SET = STATUSES.filter((x) => x !== 'new' && x !== 'ignored' && x !== 'in_conversation');
  const triaged = await TriageReply.find({ status: { $in: OWNER_SET }, companyKey: { $ne: '' } })
    .select('companyKey').lean().catch(() => []);
  const keys = new Set(triaged.map((r) => r.companyKey).filter(Boolean));

  // A company that produced a real job is unambiguously a live relationship.
  try {
    const Order = require('../models/Order');
    const withOrders = await Order.find({ companyKey: { $ne: '' } }).select('companyKey').lean();
    for (const o of withOrders) if (o.companyKey) keys.add(o.companyKey);
  } catch { /* Order model unavailable — triage evidence alone still applies */ }

  if (!keys.size) return { engaged: 0, quieted: 0 };
  const list = [...keys];
  const eng = await Client.updateMany(
    { companyKey: { $in: list }, $or: [{ engagedAt: null }, { engagedAt: { $exists: false } }] },
    { $set: { engagedAt: new Date(), engagedBy: 'backfill' } },
  ).catch(() => ({ modifiedCount: 0 }));

  // Their outstanding rows stop being signals. Only 'new' is touched: a row he
  // parked as quote_requested / follow_up is his own tracking and stays.
  const quiet = await TriageReply.updateMany(
    { companyKey: { $in: list }, status: 'new' },
    { $set: { status: 'in_conversation' } },
  ).catch(() => ({ modifiedCount: 0 }));

  const out = { engaged: eng.modifiedCount || 0, quieted: quiet.modifiedCount || 0 };
  if (out.engaged || out.quieted) {
    console.log(`[triage] engagement backfill: ${out.engaged} compan${out.engaged === 1 ? 'y' : 'ies'} marked in-conversation, ${out.quieted} row(s) quieted`);
  }
  return out;
}

async function retriageStoredReplies() {
  const rows = await TriageReply.find({ category: { $in: HUMANISH_CATEGORIES } })
    .select('subject snippet fromEmail fromName enrollmentId companyKey matched').lean();
  let demoted = 0;
  for (const r of rows) {
    let cls = classifyReply({ subject: r.subject, snippet: r.snippet, fromEmail: r.fromEmail, fromName: r.fromName });
    // Same post-match gate the live ingest applies: an unmatched, no-intent,
    // promo-shaped row (a vendor billing reminder synced before this fix) is
    // machine mail — demote it too.
    const fin = finalizeCategory({ category: cls.category, matched: !!r.matched, subject: r.subject, snippet: r.snippet });
    if (fin.downgraded) cls = { ...cls, category: fin.category };
    if (cls.category === IGNORE_CATEGORY || cls.category === 'auto_reply_ooo') {
      await TriageReply.updateOne(
        { _id: r._id },
        { $set: { category: cls.category, suggestedAction: suggestedActionFor(cls.category), status: 'ignored', handledAt: new Date() } },
      );
      // A hard auto-ack also UNDOES the warm it caused (resume drip, un-warm
      // the company) — a true OOO keeps its warm/snooze semantics.
      if (cls.category === IGNORE_CATEGORY) {
        await require('../services/warmHandoff')
          .unwarmFromReply({ enrollmentId: r.enrollmentId, companyKey: r.companyKey })
          .catch((e) => console.warn('[triage] healer un-warm failed:', e.message));
      }
      demoted += 1;
    }
  }
  if (demoted) console.log(`[triage] re-triage healer: demoted ${demoted} stored auto-repl(y/ies) out of the worklist`);
  return demoted;
}

// Healer #2 — resweep stored NDRs under the terminal-template rules. NDR rows
// synced BEFORE the "Message not delivered = hard" fix were classified
// neither-hard-nor-soft (a no-op) and are dedup-guarded against re-sync, so
// their dead enrollments stayed active. Re-run the bounce logic over recent
// stored bounce rows, HARD verdicts only — the hard path is fully idempotent
// (suppress upsert, guarded status flips, doNotEmail set), while re-running
// the soft path would double-count strike counters. Returns rows acted on.
async function resweepStoredNdrs({ windowDays = 45 } = {}) {
  const since = new Date(Date.now() - windowDays * 86400000);
  const rows = await TriageReply.find({ category: IGNORE_CATEGORY, receivedAt: { $gte: since } })
    .select('subject snippet fromEmail').lean();
  const ours = ourSendingDomains();
  let acted = 0;
  for (const r of rows) {
    const ndr = classifyBounceNdr(r, ours);
    if (!ndr.isBounce || !ndr.hard || !ndr.emails.length) continue;
    await ingestNdrBounce(r).catch((e) => console.warn('[triage] NDR resweep row failed:', e.message));
    acted += 1;
  }
  if (acted) console.log(`[triage] NDR resweep: re-processed ${acted} stored terminal bounce(s)`);
  return acted;
}

// Damage report for the quoted-footer opt-out bug — READ ONLY, on purpose.
// Before the fix, a prospect who replied WITH our footer quoted underneath ("…
// Reply 'unsubscribe' to opt out.") tripped the opt-out regex on our own words
// and got suppressed. This finds those rows: stored 'unsubscribe' replies whose
// TYPED text (quote stripped) contains no opt-out at all. It never un-suppresses
// anyone — reversing an opt-out is a legal call the owner makes deliberately,
// not something a boot-time healer should do behind his back. Logs + returns
// the list so the damage is visible and countable.
async function auditQuotedFooterOptOuts({ limit = 500 } = {}) {
  const rows = await TriageReply.find({ category: 'unsubscribe' })
    .select('fromEmail companyKey companyName subject snippet receivedAt')
    .sort({ receivedAt: -1 }).limit(limit).lean();
  const suspect = rows.filter((r) => {
    const typed = stripQuotedReply(r.snippet || '');
    // Re-ask the classifier using ONLY what they typed; still an opt-out → real.
    return classifyReply({ subject: r.subject, snippet: typed, fromEmail: r.fromEmail }).category !== 'unsubscribe';
  }).map((r) => ({
    fromEmail: r.fromEmail, companyKey: r.companyKey, companyName: r.companyName,
    subject: r.subject, receivedAt: r.receivedAt,
  }));
  if (suspect.length) {
    console.warn(`[triage] ${suspect.length} of ${rows.length} stored opt-outs look like our own quoted footer, not the sender: ${suspect.map((s) => s.fromEmail).filter(Boolean).slice(0, 10).join(', ')} — review before re-contacting (suppression left in place).`);
  }
  return { checked: rows.length, suspect };
}

// GET /api/triage/replies?category=&status=&matched=&includeIgnored=
// Bounces/auto-replies are hidden by default (they're noise) unless explicitly
// asked for via ?category=bounce_auto_ignore or ?includeIgnored=true.
async function listReplies(req, res) {
  try {
    const { category, status, matched, includeIgnored } = req.query;
    const q = {};
    if (category) q.category = category;
    else if (includeIgnored !== 'true') q.category = { $ne: IGNORE_CATEGORY };
    if (status) q.status = status;
    if (matched === 'true') q.matched = true;
    if (matched === 'false') q.matched = false;

    const replies = await TriageReply.find(q).sort({ receivedAt: -1 }).limit(500).lean();
    res.json({ replies });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/triage/replies — add one reply ({...}) or many ({ replies: [...] }).
// Used by the manual "Add reply" form and by any paste/import. Detection only.
async function addReplies(req, res) {
  try {
    const body = req.body || {};
    const raws = Array.isArray(body) ? body
      : Array.isArray(body.replies) ? body.replies
        : [body];
    if (!raws.length) return res.status(400).json({ message: 'No replies provided.' });

    const saved = [];
    const skipped = { empty: 0, self: 0, duplicate: 0 };
    for (const raw of raws) {
      const r = await ingestOne(raw);
      if (r.saved) saved.push(r.saved);
      else if (r.skip && skipped[r.skip] != null) skipped[r.skip] += 1;
    }
    res.json({ added: saved.length, skipped, replies: saved });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// The only CRM side effects V1 makes — both reuse existing safe patterns and only
// fire on a matched company. "do not contact" == the unsubscribe/bounce path
// (doNotEmail + stop active sequences); "not interested" just halts the sequence.
// companyLevel: whether the company-wide writes (doNotEmail + stop the shop's
// sequences) may fire. Defaults true — the MANUAL updateStatus path (the owner
// looking right at the reply) always acts; the AUTO path passes false on a soft
// domain-only match so a guess never punishes a whole company. Address-level
// suppression of the actual sender is unconditional either way.
async function applyStatusSideEffects(reply, status, { companyLevel = true } = {}) {
  const now = new Date();
  // Address-level suppression is company-independent — it must fire even for an
  // UNMATCHED opt-out (no companyKey), so a stranger who says "stop" is never
  // cold-emailed again anywhere, no matter how they're re-discovered.
  if (status === 'do_not_contact' && reply.fromEmail) {
    await suppress(reply.fromEmail, { reason: 'do-not-contact', source: 'triage' });
  }
  if (!companyLevel || !reply.companyKey) return;
  if (status === 'do_not_contact') {
    await Client.updateOne(
      { companyKey: reply.companyKey },
      {
        $set: { doNotEmail: true },
        $push: { log: { at: now, text: 'Do-not-contact set from reply triage', kind: 'email', dedupKey: `triage-dnc:${reply._id}` } },
      },
    );
    // closeWarm, not a status:'active' filter — a lead that REPLIED sits at
    // 'replied', which that filter can never match, so the enrollment (and the
    // warm card it renders) survived every attempt to close it.
    await closeWarm({ companyKey: reply.companyKey, reason: 'triage-do-not-contact' });
  } else if (status === 'not_interested') {
    // A human told us no — "we already design our own merch", "we use another
    // printer". That is a real answer, so it has to end the relationship in
    // every place the company can resurface, or it clogs the pipeline and the
    // drip finds them again on the next sweep:
    //   • stop the sequence            (no more touches)
    //   • doNotEmail                   (no future campaign re-enrolls them)
    //   • close the CRM stage to lost  (out of the working pipeline)
    // No follow-up date is set — there is nothing to follow up on. The card and
    // its history stay, and clearing doNotEmail re-opens them if that changes.
    // Deliberately NOT suppressed globally: suppression is for opt-outs and dead
    // addresses, and a polite "not right now" is neither.
    await closeWarm({ companyKey: reply.companyKey, reason: 'triage-not-interested' });
    await Client.updateOne(
      { companyKey: reply.companyKey },
      {
        $set: { doNotEmail: true },
        $push: { log: { at: now, text: 'Replied not interested — sequence stopped, removed from cold outreach', kind: 'email', dedupKey: `triage-ni:${reply._id}` } },
      },
    ).catch(() => {});
    // Close the stage, but never drag a real customer or a won deal backwards.
    await Client.updateOne(
      { companyKey: reply.companyKey, stage: { $nin: ['won', 'customer', 'lost', 'dormant'] } },
      { $set: { stage: 'lost' } },
    ).catch(() => {});
  }
}

// PATCH /api/triage/replies/:id — set the triage status.
async function updateStatus(req, res) {
  try {
    const { status } = req.body || {};
    if (!isValidStatus(status)) {
      return res.status(400).json({ message: `Invalid status. Must be one of: ${require('../services/replyTriage').STATUSES.join(', ')}` });
    }
    const reply = await TriageReply.findById(req.params.id);
    if (!reply) return res.status(404).json({ message: 'Reply not found.' });

    reply.status = status;
    reply.handledAt = status === 'new' ? null : new Date();

    // "Once i mark a conversation once i shouldnt have to do it again." THIS is
    // the click he meant, and it is deliberately sufficient on its own — the
    // Sent-folder scan is an accelerator that saves him this click, never a
    // dependency. It can be blind (wrong mailbox, aliased From, an unlisted
    // folder name) and report success while seeing nothing, so if answering in
    // Gmail were the only trigger the whole feature would quietly degrade back
    // to today's behavior and he would be telling me a third time.
    if (status !== 'new') {
      await markEngaged(reply.companyKey, 'triage').catch(() => {});
    }

    // Owner correction: "that wasn't a real reply" (an auto-responder slipped
    // past the classifier and warmed the company / stopped the drip). Beyond
    // dismissing the row, reclassify it AND undo the warm side-effects — the
    // enrollment resumes, the false warm comes off the Today queue, and the
    // hub's "warm lead waiting" banner clears.
    if (status === 'ignored' && req.body && req.body.notARealReply === true) {
      reply.category = 'bounce_auto_ignore';
      reply.suggestedAction = suggestedActionFor('bounce_auto_ignore');
      try {
        await require('../services/warmHandoff').unwarmFromReply({
          enrollmentId: reply.enrollmentId, companyKey: reply.companyKey,
        });
      } catch (e) {
        console.warn('[triage] un-warm failed:', e.message);
      }
    }
    await reply.save();

    // Side effects are best-effort: a triage state change should still succeed
    // even if the linked company write hiccups.
    let sideEffectWarning = null;
    try {
      await applyStatusSideEffects(reply, status);
    } catch (se) {
      sideEffectWarning = se.message;
      console.warn('[triage] status side-effect failed:', se.message);
    }

    res.json({ ok: true, reply: reply.toObject(), sideEffectWarning });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/triage/replies/:id/start-job { title?, value?, reuse? }
// The one-tap "this is a real customer now" — from the reply that earned it.
//
// Everything downstream already existed (project, deal card, CRM promotion); what
// was missing was the bridge, so converting a lead meant retyping the shop's name
// into the CRM and hoping the sequence noticed. This runs the SAME handoff the
// CRM's "Start new job" runs, stops the drip, carries the person who actually
// wrote to us onto the project as its contact, and hands the frontend the project
// number so it can drop the owner straight into building the quote.
async function startJobFromReply(req, res) {
  try {
    const reply = await TriageReply.findById(req.params.id);
    if (!reply) return res.status(404).json({ message: 'Reply not found.' });
    if (!reply.companyKey) {
      // An unmatched reply has no company to attach a project to. Say which one,
      // so the fix ("link this reply to a company first") is obvious.
      return res.status(400).json({ message: 'This reply isn’t matched to a company yet — link it to a lead first.' });
    }

    const body = req.body || {};
    const out = await require('../services/warmHandoff').convertToJob({
      companyKey: reply.companyKey,
      enrollmentId: reply.enrollmentId || null,
      contactEmail: reply.fromEmail || '',
      contactName: reply.fromName || '',
      title: body.title || '',
      value: Number(body.value) || 0,
      reuse: body.reuse !== false,      // default: attach to the live project
      reason: `Replied to outreach and converted to a job (${reply.category || 'reply'})`,
    });
    if (!out.ok) return res.status(400).json({ message: out.reason || 'could not start the job' });

    // The reply is dealt with — it produced a job. Keep the row (history) but
    // take it out of the worklist.
    reply.status = 'handled';
    reply.handledAt = new Date();
    await reply.save();
    // Starting a job is the least ambiguous statement in the system that this
    // is a real, live relationship.
    await markEngaged(reply.companyKey, 'job').catch(() => {});

    res.status(out.created ? 201 : 200).json({ ok: true, ...out, reply: reply.toObject() });
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
}

// ── Read-only Gmail ingest (Wave 2) ───────────────────────────────────────────
// Uses the gated GMAIL_* refresh-token creds to pull recent inbound replies via
// the Gmail REST API (no googleapis dep — Node's global fetch), and runs each
// through ingestOne (which dedupes by gmailMessageId + fires the auto-actions).
// Read-only: it never modifies the mailbox.

async function gmailAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID,
      client_secret: process.env.GMAIL_CLIENT_SECRET,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`gmail token exchange ${res.status}`);
  const j = await res.json();
  if (!j.access_token) throw new Error('gmail token: no access_token');
  return j.access_token;
}

async function gmailApi(path, token) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`gmail api ${res.status} on ${path.split('?')[0]}`);
  return res.json();
}

// ── Sync cursor + triage identity (persisted in the generic SiteSetting store) ─
// Both survive a restart and are readable without a live Gmail call, following
// the same key/value pattern the finance/site settings already use.
const SYNC_KEY = 'gmailTriageSync';         // { lastCompleteAt, lastInternalDate }
const IDENTITY_KEY = 'gmailTriageIdentity'; // { address, checkedAt }
const IDENTITY_TTL_MS = 6 * 60 * 60 * 1000; // re-ask Gmail who we are twice a day
const IDENTITY_RETRY_MS = 10 * 60 * 1000;   // …and never hammer it when it's down
const MAX_SYNC_PAGES = 10;                  // hard ceiling on Gmail list pages/run
const PAGE_SIZE = 100;                      // Gmail's max page for messages.list
const MAX_GAP_DAYS = 30;                    // widest catch-up window we'll ever ask for

const settingsModel = () => require('../models/SiteSetting');

async function readSetting(key) {
  try {
    const doc = await settingsModel().findOne({ key }).lean();
    return (doc && doc.value && typeof doc.value === 'object') ? doc.value : null;
  } catch { return null; }
}
async function writeSetting(key, value) {
  try {
    await settingsModel().findOneAndUpdate(
      { key }, { $set: { value, updatedAt: new Date() } }, { upsert: true },
    );
  } catch (e) { console.warn('[triage] setting write failed:', e.message); }
}

// How far back this run must look. PURE (now injected) so it's unit-tested.
// The rolling window is a floor, not a ceiling: if the last COMPLETE sync was
// days ago (cron down, API redeploy, a run that errored out), widen to cover the
// gap so those replies are re-scanned instead of silently skipped forever.
// Bounded at MAX_GAP_DAYS so a long outage can't ask Gmail for everything.
function syncWindowDays({ windowDays = 7, lastCompleteAt = null } = {}, now = new Date()) {
  const base = Math.max(1, Math.round(windowDays));
  const t = lastCompleteAt ? new Date(lastCompleteAt).getTime() : NaN;
  if (!Number.isFinite(t)) return Math.min(MAX_GAP_DAYS, base);
  const gap = Math.ceil((now.getTime() - t) / 86400000) + 1; // +1 day of overlap
  return Math.min(MAX_GAP_DAYS, Math.max(base, gap));
}

// Walk Gmail's paged messages.list until we run out of pages or hit a bound.
// `fetchPage(pageToken)` is injected so the paging/bounding logic is unit-tested
// without the network. Returns { ids, pages, truncated } — `truncated` means we
// stopped early, which is what keeps the cursor from advancing past unseen mail.
async function collectMessageIds(fetchPage, { maxMessages = 250, maxPages = MAX_SYNC_PAGES } = {}) {
  const ids = [];
  let pageToken = '';
  let pages = 0;
  let truncated = false;
  while (pages < maxPages) {
    const page = await fetchPage(pageToken);
    pages += 1;
    for (const m of (page && page.messages) || []) if (m && m.id) ids.push(m.id);
    pageToken = (page && page.nextPageToken) || '';
    if (!pageToken) break;
    if (ids.length >= maxMessages) break;
  }
  if (pageToken) truncated = true;                      // more pages Gmail still has
  if (ids.length > maxMessages) { ids.length = maxMessages; truncated = true; }
  return { ids, pages, truncated };
}

// Ask Gmail which mailbox this refresh token actually belongs to. Never throws.
async function fetchGmailProfile(token) {
  try {
    const t = token || await gmailAccessToken();
    const prof = await gmailApi('profile', t);
    const addr = normEmail(prof && prof.emailAddress);
    return addr || '';
  } catch (e) {
    console.warn('[triage] gmail profile lookup failed:', e.message);
    return '';
  }
}

let identityMemo = null;      // { at, address, checkedAt }
let identityAttemptAt = 0;

// getTriageIdentity() — WHICH mailbox the reply sync is actually reading.
// The whole "zero replies" question hangs on this: replies land wherever the
// outreach mail says to reply, and the Studio only ever sees THIS mailbox. If
// the two differ, every reply is invisible — so the address is published rather
// than assumed. Cheap (memo + persisted value), and it never throws.
async function getTriageIdentity({ refresh = false } = {}) {
  // The IMAP reader answers ONLY when it can genuinely read a mailbox — it reads
  // the address we send from, which is by definition where replies land. When
  // the sender is a send-only relay (Resend/SendGrid/SES host no inbox) it stays
  // silent and the Gmail grant answers instead. It must never speak over a
  // working Gmail sync: doing that once made the Studio report that it "reads
  // resend", which is a service login, not an inbox.
  const imapAddress = (() => {
    try { return require('../services/replyImap').imapMailbox(); } catch { return ''; }
  })();
  if (imapAddress) return { address: normEmail(imapAddress), checkedAt: new Date(), configured: true };

  const configured = isGmailConfigured();
  try {
    if (!refresh && identityMemo && Date.now() - identityMemo.at < 60 * 1000) {
      return { address: identityMemo.address, checkedAt: identityMemo.checkedAt, configured };
    }
    const stored = await readSetting(IDENTITY_KEY);
    let address = stored && typeof stored.address === 'string' ? normEmail(stored.address) : '';
    let checkedAt = stored && stored.checkedAt ? new Date(stored.checkedAt) : null;
    if (checkedAt && isNaN(checkedAt.getTime())) checkedAt = null;

    const stale = !checkedAt || (Date.now() - checkedAt.getTime()) > IDENTITY_TTL_MS;
    const mayAsk = configured && (refresh || stale) && (Date.now() - identityAttemptAt) > IDENTITY_RETRY_MS;
    if (mayAsk) {
      identityAttemptAt = Date.now();
      const fresh = await fetchGmailProfile(null);
      if (fresh) {
        address = fresh;
        checkedAt = new Date();
        await writeSetting(IDENTITY_KEY, { address, checkedAt });
      }
    }
    identityMemo = { at: Date.now(), address, checkedAt };
    return { address, checkedAt, configured };
  } catch (e) {
    console.warn('[triage] triage identity unavailable:', e.message);
    return { address: '', checkedAt: null, configured };
  }
}

// Record the mailbox a live sync authenticated as (we already hold a token, so
// this costs one cheap call and keeps the persisted identity warm).
async function refreshTriageIdentity(token) {
  const address = await fetchGmailProfile(token);
  if (!address) return '';
  const checkedAt = new Date();
  await writeSetting(IDENTITY_KEY, { address, checkedAt });
  identityMemo = { at: Date.now(), address, checkedAt };
  return address;
}

// Pull recent inbound replies and ingest them. Paged and bounded (maxMessages ×
// maxPages) and safe to re-run (ingestOne dedupes). Returns a summary — including
// per-message failure counts, so "0 imported (50 scanned)" can no longer look
// identical to a completely broken ingest — and records last-sync on state.
async function runGmailSync({ maxMessages = 250, windowDays = 7, maxPages = MAX_SYNC_PAGES } = {}) {
  if (!isGmailConfigured()) return { configured: false, imported: 0 };
  const token = await gmailAccessToken();
  const cursor = (await readSetting(SYNC_KEY)) || {};
  const effectiveWindow = syncWindowDays({ windowDays, lastCompleteAt: cursor.lastCompleteAt });
  const q = encodeURIComponent(gmailQuery({ windowDays: effectiveWindow }));
  const { ids, pages, truncated } = await collectMessageIds(
    (pageToken) => gmailApi(
      `messages?q=${q}&maxResults=${PAGE_SIZE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      token,
    ),
    { maxMessages, maxPages },
  );
  let imported = 0;
  let errors = 0;
  let fromSpam = 0;
  let newestInternalDate = Number(cursor.lastInternalDate) || 0;
  const errorSamples = [];
  const noteError = (id, e) => {
    errors += 1;
    if (errorSamples.length < 5) errorSamples.push(`${id}: ${e && e.message ? e.message : String(e)}`);
  };
  const skipped = { empty: 0, self: 0, duplicate: 0 };
  // Pull the auto-reply / bulk detection headers alongside the routing ones, so
  // an auto-responder is caught by its RFC headers even when its wording is novel.
  const HEADERS = [
    'From', 'Subject', 'Message-Id', 'In-Reply-To', 'References', 'Date',
    'Auto-Submitted', 'Precedence', 'X-Autoreply', 'X-Autorespond', 'X-Autoresponse',
    'X-Auto-Response-Suppress', 'List-Id', 'List-Unsubscribe-Post',
    // Bulk/marketing fingerprints (vendor billing reminders, newsletters, ESP
    // blasts) — headerSaysAuto treats any of these as "not a 1:1 human reply".
    'List-Unsubscribe', 'Feedback-Id', 'X-Feedback-Id',
    'X-SG-EID', 'X-Mailgun-Sid', 'X-SES-Outgoing', 'X-Mandrill-User',
  ].map((h) => `metadataHeaders=${h}`).join('&');
  for (const id of ids) {
    let msg = null;
    try {
      msg = await gmailApi(`messages/${id}?format=metadata&${HEADERS}`, token);
    } catch (e) {
      noteError(id, e);       // counted + logged below — never a silent skip
      continue;
    }
    if (!msg) { noteError(id, new Error('empty message payload')); continue; }
    // A reply Gmail filed under Spam/Trash is still a reply — we only COUNT the
    // folder (so the summary can say so); nothing downstream treats it as lesser.
    const labels = (msg.labelIds || []);
    if (labels.includes('SPAM') || labels.includes('TRASH')) fromSpam += 1;
    const internal = Number(msg.internalDate) || 0;
    if (internal > newestInternalDate) newestInternalDate = internal;
    const h = {};
    for (const hdr of (msg.payload && msg.payload.headers) || []) h[hdr.name.toLowerCase()] = hdr.value;
    const { email, name } = parseFromHeader(h.from);
    let r;
    try {
      r = await ingestOne({
        fromEmail: email,
        fromName: name,
        subject: h.subject || '',
        snippet: msg.snippet || '',
        receivedAt: msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(),
        inReplyTo: h['in-reply-to'] || '',
        references: h.references || '',
        headers: h,   // full lowercased header map → auto/bulk detection
        gmailMessageId: id,
        source: 'gmail',
      });
    } catch (e) {
      // A concurrent sync (the 10-min cron overlapping a manual POST /triage/sync)
      // can both pass the findOne dedupe then race the unique gmailMessageId
      // insert → E11000 on the loser. One row never aborts the batch (it re-syncs
      // next tick) — but it IS counted and logged, because a run where every
      // ingest throws used to look exactly like a quiet mailbox.
      const dup = /E11000|duplicate key/i.test(e.message || '');
      if (dup) skipped.duplicate += 1;
      else noteError(id, e);
      continue;
    }
    if (r.saved) imported += 1;
    else if (r.skip && skipped[r.skip] != null) skipped[r.skip] += 1;
  }

  // The cursor only advances on a run that saw EVERYTHING it asked for. A
  // truncated or partly-failed run leaves the old stamp in place, so the next
  // run widens its window back over the gap instead of skipping it forever.
  const complete = !truncated && errors === 0;
  if (complete) {
    await writeSetting(SYNC_KEY, {
      lastCompleteAt: new Date(),
      lastInternalDate: newestInternalDate || null,
      lastScanned: ids.length,
    });
  }
  if (errors) {
    console.warn(`[triage] gmail sync: ${errors} message(s) failed to ingest (${ids.length} scanned) — ${errorSamples.join(' | ')}`);
  }
  if (truncated) {
    console.warn(`[triage] gmail sync hit its per-run bound (${ids.length} messages, ${pages} page(s)) — window stays open for the next tick`);
  }
  await refreshTriageIdentity(token).catch(() => {});
  await OutreachState.findOneAndUpdate(
    { key: 'engine' },
    { $set: { gmailLastSyncAt: new Date(), gmailLastCount: imported } },
    { upsert: true },
  ).catch(() => {});
  return {
    configured: true, scanned: ids.length, imported, skipped,
    errors, errorSamples, fromSpam, pages, truncated, complete,
    windowDays: effectiveWindow,
  };
}

// POST /api/triage/sync — run the read-only Gmail pull now (owner-triggered),
// or report honestly that it's not configured.
async function syncGmail(_req, res) {
  if (!isGmailConfigured()) {
    return res.json({
      configured: false, imported: 0,
      message: 'Gmail auto-sync is not set up. Add replies manually, or set GMAIL_TRIAGE_ENABLED + Gmail credentials to enable read-only sync.',
    });
  }
  try {
    const r = await runGmailSync();
    // Say out loud what the run actually did: how many messages failed to ingest,
    // how many came out of Spam/Trash, and which mailbox we're even reading.
    const parts = [`${r.scanned} scanned`];
    if (r.fromSpam) parts.push(`${r.fromSpam} from spam/trash`);
    if (r.errors) parts.push(`${r.errors} failed`);
    if (r.truncated) parts.push('more waiting — run again');
    const who = await getTriageIdentity();
    res.json({
      ...r,
      mailbox: who.address,
      message: `Synced Gmail${who.address ? ` (${who.address})` : ''} — ${r.imported} new repl${r.imported === 1 ? 'y' : 'ies'} imported (${parts.join(', ')}).`,
    });
  } catch (e) {
    res.status(502).json({ configured: true, imported: 0, message: `Gmail sync failed: ${e.message}` });
  }
}

// GET /api/triage/sync-status — the live "last synced Xm ago · N new" pill.
async function getSyncStatus(_req, res) {
  try {
    const st = await OutreachState.findOne({ key: 'engine' }).select('gmailLastSyncAt gmailLastCount').lean();
    // `mailbox` is the honest answer to "whose replies is this counter counting?"
    const who = await getTriageIdentity();
    const cursor = (await readSetting(SYNC_KEY)) || {};
    res.json({
      configured: isGmailConfigured(),
      lastSyncAt: st ? st.gmailLastSyncAt : null,
      lastCount: st ? st.gmailLastCount : 0,
      mailbox: who.address,
      mailboxCheckedAt: who.checkedAt,
      lastCompleteSyncAt: cursor.lastCompleteAt || null,
    });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// Cron: read-only Gmail ingest every 10 min (only when configured). Modeled on
// the outreach engine + jpwScheduler crons; started from server.js.
function startGmailIngest() {
  // The COLD-SENDING mailbox is read over IMAP with the credentials the sender
  // already holds (SMTP_USER/SMTP_PASS). That mailbox is where replies to cold
  // email actually land, so this is the path that matters — and it needs no
  // setup at all, unlike the Gmail OAuth grant below, which is wired by hand and
  // can silently point at a different account. Both feed the same ingestOne, and
  // the RFC Message-ID dedupe means a message seen by both is stored once.
  startImapIngest();

  if (!isGmailConfigured()) {
    console.log('[triage] Gmail ingest idle — set GMAIL_TRIAGE_ENABLED + GMAIL_* creds to enable read-only reply sync');
    return;
  }
  cron.schedule('3,13,23,33,43,53 * * * *', () => {
    runGmailSync()
      .then((r) => {
        if (r.imported || r.errors || r.truncated) {
          console.log(`[triage] gmail sync: +${r.imported} new (${r.scanned} scanned, ${r.fromSpam} spam/trash, ${r.errors} failed${r.truncated ? ', truncated' : ''})`);
        }
      })
      .catch((e) => console.warn('[triage] gmail sync failed:', e.message));
  });
  console.log('[triage] Gmail read-only reply ingest started — every 10 min');
  // Once per boot, say out loud which mailbox we're reading (the reply-path
  // check depends on it) and how many stored opt-outs were our own footer.
  getTriageIdentity({ refresh: true })
    .then((id) => { if (id.address) console.log(`[triage] reply sync is reading ${id.address}`); })
    .catch(() => {});
  auditQuotedFooterOptOuts().catch((e) => console.warn('[triage] opt-out audit failed:', e.message));
}

// Read the sending mailbox itself, every 10 minutes, offset from the Gmail tick
// so two syncs never hammer the same minute. Idle and silent when there are no
// SMTP credentials or the provider is a send-only relay with no mailbox.
function startImapIngest() {
  const { runImapSync, imapMailbox } = require('../services/replyImap');
  const mailbox = imapMailbox();
  if (!mailbox) {
    console.log('[triage] sending-mailbox reader idle — no SMTP/IMAP credentials, or a send-only relay');
    return;
  }
  cron.schedule('5,15,25,35,45,55 * * * *', () => {
    runImapSync()
      .then((r) => {
        if (r && (r.imported || r.errors)) {
          console.log(`[triage] sending-mailbox sync: +${r.imported} new (${r.scanned} scanned, ${r.errors} failed)`);
        }
      })
      .catch((e) => console.warn('[triage] sending-mailbox sync failed:', e.message));
  });
  console.log(`[triage] reading the sending mailbox (${mailbox}) every 10 min — replies surface in the Studio with no extra setup`);
  // Kick once shortly after boot so a fresh deploy doesn't wait for the cron.
  setTimeout(() => { runImapSync().catch(() => {}); }, 20_000);
}

// GET /api/triage/worklist — the Follow-Up Command Center's action buckets.
// Groups the OPEN triage replies into needs-response / quote / mockup / follow-up
// (see worklistFromReplies), then adds a bridge bucket: companies the owner MARKED
// replied via the existing outreach button whose reply hasn't been triaged yet — so
// the old manual "mark replied" flow and the new triage inbox line up. Read-only;
// makes no CRM writes.
async function getWorklist(_req, res) {
  try {
    const replies = await TriageReply.find({
      status: { $in: ['new', 'follow_up', 'mockup_requested', 'quote_requested'] },
      category: { $ne: IGNORE_CATEGORY },
    }).sort({ receivedAt: -1 }).limit(500).lean();

    const buckets = worklistFromReplies(replies);

    // Bridge: enrollments marked 'replied' whose company has no triage row yet.
    const repliedEnr = await OutreachEnrollment.find({ status: 'replied' })
      .select('companyKey companyName toEmail repliedAt')
      .sort({ repliedAt: -1 }).limit(200).lean();
    const enrKeys = [...new Set(repliedEnr.map((e) => e.companyKey).filter(Boolean))];
    const triagedKeys = new Set(
      (await TriageReply.find({ companyKey: { $in: enrKeys } }).select('companyKey').lean())
        .map((r) => r.companyKey),
    );
    // ...and never for a company he is already talking to. This bucket bypasses
    // TriageReply entirely — it is built from enrollments — so the row status
    // can never quiet it, and it would have gone on surfacing Apothecare after
    // every other channel was fixed. Engagement is per-COMPANY precisely so the
    // one door that has no reply row can still read it.
    const engagedKeys = new Set(
      (await Client.find({ companyKey: { $in: enrKeys }, engagedAt: { $ne: null } })
        .select('companyKey').lean().catch(() => []))
        .map((c) => c.companyKey),
    );
    const untriagedReplied = repliedEnr
      .filter((e) => e.companyKey && !triagedKeys.has(e.companyKey) && !engagedKeys.has(e.companyKey))
      .map((e) => ({
        _id: String(e._id),
        enrollmentId: String(e._id),
        companyKey: e.companyKey,
        companyName: e.companyName,
        fromEmail: e.toEmail || '',
        repliedAt: e.repliedAt,
        matched: true,
      }));

    const counts = {
      needsResponse: buckets.needsResponse.length,
      quoteRequested: buckets.quoteRequested.length,
      mockupRequested: buckets.mockupRequested.length,
      followUp: buckets.followUp.length,
      untriagedReplied: untriagedReplied.length,
    };
    counts.total = Object.values(counts).reduce((a, b) => a + b, 0);

    res.json({ ...buckets, untriagedReplied, counts });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

module.exports = {
  listReplies, addReplies, updateStatus, startJobFromReply, syncGmail, getSyncStatus, getWorklist,
  ingestOne, closeOnOwnReply, repairStoredReply, backfillEngagedConversations,
  markEngaged, statusForIncoming, applyStatusSideEffects, runGmailSync, startGmailIngest, retriageStoredReplies,
  resweepStoredNdrs, auditQuotedFooterOptOuts,
  // Shared contract: which mailbox the reply sync is authenticated as (read by
  // the outreach overview to detect a reply black hole).
  getTriageIdentity,
  // Pure sync internals, exported for the unit tests.
  syncWindowDays, collectMessageIds, MAX_SYNC_PAGES,
};
