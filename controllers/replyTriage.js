// controllers/replyTriage.js
//
// Gmail Reply Triage V1 — a small, detection-only inbox for buyer replies to cold
// outreach. It classifies each reply (services/replyTriage.js), matches it to an
// existing outreach lead by email/subject, and lets the owner triage it. It never
// sends email and never auto-migrates a lead into the order flow. The only CRM
// write it makes is the safe, already-established one: a "do not contact" flips the
// company's existing doNotEmail flag and stops its active sequences — the same
// thing the public unsubscribe + bounce paths already do.

const TriageReply = require('../models/TriageReply');
const OutreachEnrollment = require('../models/OutreachEnrollment');
const Client = require('../models/Client');
const {
  classifyReply,
  matchReply,
  suggestedActionFor,
  isValidStatus,
  normEmail,
  isGmailConfigured,
  worklistFromReplies,
} = require('../services/replyTriage');

const IGNORE_CATEGORY = 'bounce_auto_ignore';
const VALID_SOURCES = ['manual', 'import', 'gmail'];

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

  const { category, self } = classifyReply({ subject, snippet, fromEmail, fromName });
  if (self) return { skip: 'self' }; // our own outbound mail is never a reply

  // Candidate matches (loaded here; matchReply itself is pure/testable).
  let enrollments = [];
  let clients = [];
  if (fromEmail) {
    [enrollments, clients] = await Promise.all([
      OutreachEnrollment.find({ toEmail: fromEmail }).select('companyKey companyName toEmail sends').lean(),
      Client.find({ $or: [{ email: fromEmail }, { 'contacts.email': fromEmail }] })
        .select('companyKey companyName email contacts').lean(),
    ]);
  }
  const match = matchReply(fromEmail, subject, {
    enrollments: enrollments.map((e) => ({ ...e, subjects: (e.sends || []).map((s) => s.subject) })),
    clients,
  });

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
    companyKey: match.companyKey,
    companyName: match.companyName,
    enrollmentId: match.enrollmentId || null,
    source,
    gmailMessageId,
  });
  return { saved: doc.toObject() };
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
async function applyStatusSideEffects(reply, status) {
  if (!reply.companyKey) return;
  const now = new Date();
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

// POST /api/triage/sync — Gmail sync seam. V1 does NOT fetch from Gmail (that read-
// only OAuth is a separate, opt-in PR). This reports honestly whether a sync could
// run so the UI can prompt the owner to add replies manually for now.
async function syncGmail(_req, res) {
  const configured = isGmailConfigured();
  res.json({
    configured,
    imported: 0,
    message: configured
      ? 'Gmail credentials are set, but the read-only fetch ships in a later version. No messages were pulled.'
      : 'Gmail auto-sync is not set up. Add replies manually for now, or set GMAIL_TRIAGE_ENABLED + Gmail credentials to enable it later.',
  });
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

module.exports = { listReplies, addReplies, updateStatus, syncGmail, getWorklist, ingestOne, applyStatusSideEffects };
