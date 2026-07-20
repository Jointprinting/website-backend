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
  isGmailConfigured,
  worklistFromReplies,
} = require('../services/replyTriage');
const { warmFromEnrollment } = require('../services/warmHandoff');
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

// Classify + match one raw reply and persist it. Own sent mail is dropped (not a
// reply); everything else — including bounces/auto-replies and unmatched senders —
// is stored so nothing silently disappears. Returns { saved, skip }.
async function ingestOne(raw = {}) {
  const fromEmail = normEmail(raw.fromEmail);
  const subject = String(raw.subject || '').trim();
  const snippet = String(raw.snippet || raw.body || '').trim().slice(0, 600);
  const fromName = String(raw.fromName || '').trim();

  if (!fromEmail && !subject && !snippet) return { skip: 'empty' };

  // Dedupe a re-synced Gmail message (manual rows carry no id).
  const gmailMessageId = raw.gmailMessageId ? String(raw.gmailMessageId) : null;
  if (gmailMessageId) {
    const dup = await TriageReply.findOne({ gmailMessageId }).select('_id').lean();
    if (dup) return { skip: 'duplicate' };
  }

  // Pass the raw header map through so classifyReply can use the RFC-standard
  // auto/bulk signals (Auto-Submitted / Precedence / X-Auto* / List-*), which are
  // far more reliable than subject/body wording for catching auto-responders.
  const cls = classifyReply({ subject, snippet, fromEmail, fromName, headers: raw.headers || null });
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

  // Post-match final say: unmatched + no buying signal + promotional shape is
  // machine mail (the Google Workspace "free trial is ending" class), never a
  // lead. Matched replies and anything with real intent pass through untouched.
  const fin = finalizeCategory({ category: cls.category, matched: match.matched, subject, snippet });
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
    status: 'new',
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
    if (keys.size) {
      await Client.updateMany({ companyKey: { $in: [...keys] } }, { $set: { doNotEmail: true } }).catch(() => {});
    }
    console.log(`[triage] NDR hard bounce → suppressed ${email} (${keys.size} compan${keys.size === 1 ? 'y' : 'ies'})`);
  }
}

// One-time healer: re-run the (now header/wording-aware) classifier over replies
// that were ingested BEFORE the auto-responder fix and are still sitting in a
// human/actionable bucket. Any that are actually machine auto-acks (e.g. an
// "Auto response: …" caught by subject) are demoted to bounce_auto_ignore +
// status 'ignored', so they drop out of the triage worklist AND the hub banner
// without the owner touching anything. Idempotent; safe to re-run. Returns count.
const HUMANISH_CATEGORIES = ['hot_lead', 'needs_response', 'asked_pricing', 'asked_mockups', 'follow_up_later', 'wrong_person'];
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
    await OutreachEnrollment.updateMany(
      { companyKey: reply.companyKey, status: 'active' },
      { $set: { status: 'stopped', stopReason: 'triage-do-not-contact', nextSendAt: null } },
    );
  } else if (status === 'not_interested') {
    await OutreachEnrollment.updateMany(
      { companyKey: reply.companyKey, status: 'active' },
      { $set: { status: 'stopped', stopReason: 'triage-not-interested', nextSendAt: null } },
    );
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

// Pull recent inbound replies and ingest them. Bounded (maxMessages) and safe to
// re-run (ingestOne dedupes). Returns a summary; records last-sync on state.
async function runGmailSync({ maxMessages = 50, windowDays = 7 } = {}) {
  if (!isGmailConfigured()) return { configured: false, imported: 0 };
  const token = await gmailAccessToken();
  const q = encodeURIComponent(gmailQuery({ windowDays }));
  const list = await gmailApi(`messages?q=${q}&maxResults=${maxMessages}`, token);
  const ids = (list.messages || []).map((m) => m.id);
  let imported = 0;
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
    const msg = await gmailApi(`messages/${id}?format=metadata&${HEADERS}`, token).catch(() => null);
    if (!msg) continue;
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
      // insert → E11000 on the loser. Swallow any single-row failure so one
      // message never aborts the rest of the batch (it re-syncs next tick).
      continue;
    }
    if (r.saved) imported += 1;
    else if (r.skip && skipped[r.skip] != null) skipped[r.skip] += 1;
  }
  await OutreachState.findOneAndUpdate(
    { key: 'engine' },
    { $set: { gmailLastSyncAt: new Date(), gmailLastCount: imported } },
    { upsert: true },
  ).catch(() => {});
  return { configured: true, scanned: ids.length, imported, skipped };
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
    res.json({ ...r, message: `Synced Gmail — ${r.imported} new repl${r.imported === 1 ? 'y' : 'ies'} imported (${r.scanned} scanned).` });
  } catch (e) {
    res.status(502).json({ configured: true, imported: 0, message: `Gmail sync failed: ${e.message}` });
  }
}

// GET /api/triage/sync-status — the live "last synced Xm ago · N new" pill.
async function getSyncStatus(_req, res) {
  try {
    const st = await OutreachState.findOne({ key: 'engine' }).select('gmailLastSyncAt gmailLastCount').lean();
    res.json({
      configured: isGmailConfigured(),
      lastSyncAt: st ? st.gmailLastSyncAt : null,
      lastCount: st ? st.gmailLastCount : 0,
    });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// Cron: read-only Gmail ingest every 10 min (only when configured). Modeled on
// the outreach engine + jpwScheduler crons; started from server.js.
function startGmailIngest() {
  if (!isGmailConfigured()) {
    console.log('[triage] Gmail ingest idle — set GMAIL_TRIAGE_ENABLED + GMAIL_* creds to enable read-only reply sync');
    return;
  }
  cron.schedule('*/10 * * * *', () => {
    runGmailSync()
      .then((r) => { if (r.imported) console.log(`[triage] gmail sync: +${r.imported} new (${r.scanned} scanned)`); })
      .catch((e) => console.warn('[triage] gmail sync failed:', e.message));
  });
  console.log('[triage] Gmail read-only reply ingest started — every 10 min');
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
    const untriagedReplied = repliedEnr
      .filter((e) => e.companyKey && !triagedKeys.has(e.companyKey))
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
  listReplies, addReplies, updateStatus, syncGmail, getSyncStatus, getWorklist,
  ingestOne, applyStatusSideEffects, runGmailSync, startGmailIngest, retriageStoredReplies,
  resweepStoredNdrs,
};
