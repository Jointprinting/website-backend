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
  const cls = classifyReply({ subject, snippet: body, fromEmail, fromName, headers });
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
  return { repaired: true, promoted, category };
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
      .select('_id snippet category status matched').lean();
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
  cron.schedule('*/10 * * * *', () => {
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
  listReplies, addReplies, updateStatus, startJobFromReply, syncGmail, getSyncStatus, getWorklist,
  ingestOne, repairStoredReply, applyStatusSideEffects, runGmailSync, startGmailIngest, retriageStoredReplies,
  resweepStoredNdrs, auditQuotedFooterOptOuts,
  // Shared contract: which mailbox the reply sync is authenticated as (read by
  // the outreach overview to detect a reply black hole).
  getTriageIdentity,
  // Pure sync internals, exported for the unit tests.
  syncWindowDays, collectMessageIds, MAX_SYNC_PAGES,
};
