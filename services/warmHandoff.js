// services/warmHandoff.js
//
// The single, shared "a human replied — go warm" transition. Extracted from
// controllers/outreach.js markReplied so the manual "They replied" button AND
// automatic reply ingest (controllers/replyTriage.js) run the EXACT same
// handoff and can never drift apart: stop the drip, flip the company warm, and
// drop it into the CRM's Today queue with one logged, de-duplicated touch.
//
// PURE of HTTP: takes a live enrollment (or a bare companyKey) + context, does
// the DB writes, returns a small summary. Idempotent: the dedupKey guard stops a
// re-run (button pressed twice, reply re-synced) from piling up duplicate log
// lines, and terminal enrollments keep their own status while the company still
// warms.

const OutreachCampaign = require('../models/OutreachCampaign');
const Client = require('../models/Client');
const { promoteStage } = require('../controllers/crm');
const { etToday } = require('../utils/time');

// Flip the COMPANY warm in the CRM: 'warm' tag, follow up TODAY (lands in the
// Today call queue), stage nudged → contacted, one logged touch. Safe when the
// companyKey is blank (no-op) or the Client is missing (unmatched reply).
async function warmCompany(companyKey, opts = {}) {
  if (!companyKey) return { ok: false, reason: 'no-company' };
  const now = opts.now instanceof Date ? opts.now : new Date();
  const client = await Client.findOne({ companyKey });
  if (!client) return { ok: false, reason: 'no-client' };

  // Never resurface an opted-out company into the Today call queue. If they've
  // been set do-not-contact (unsubscribe / hard bounce), a later positive-sounding
  // reply must NOT re-tag them warm, set a follow-up, or promote the stage — that
  // would drop a suppressed lead back in front of the owner to email. We still log
  // the reply (best-effort, de-duped) so it isn't silently lost.
  if (client.doNotEmail === true) {
    const dedupKey = opts.dedupKey
      || (opts.enrollmentId ? `outreach-reply:${opts.enrollmentId}` : `outreach-reply:${companyKey}`);
    const already = (client.log || []).some((l) => l && l.dedupKey === dedupKey);
    if (!already) {
      client.log.push({ at: now, text: 'Reply received on an opted-out company (not re-queued — still do-not-contact)', kind: 'email', dedupKey });
      await client.save();
    }
    return { ok: true, warmed: false, doNotEmail: true, logged: !already };
  }

  let campaignName = opts.campaignName || '';
  if (!campaignName && opts.campaignId) {
    const c = await OutreachCampaign.findById(opts.campaignId).select('name').lean();
    campaignName = c ? c.name : '';
  }

  const tags = Array.isArray(client.tags) ? client.tags : [];
  if (!tags.some((t) => String(t).toLowerCase() === 'warm')) tags.push('warm');
  client.tags = tags;
  client.nextFollowUp = new Date(`${etToday(now)}T00:00:00.000Z`); // today → Today queue
  client.lastContact = now;
  client.stage = promoteStage(client.stage, 'contacted');

  const dedupKey = opts.dedupKey
    || (opts.enrollmentId ? `outreach-reply:${opts.enrollmentId}` : `outreach-reply:${companyKey}`);
  // Idempotent: don't stack the same "replied" line on a re-run / re-sync.
  const already = (client.log || []).some((l) => l && l.dedupKey === dedupKey);
  if (!already) {
    const text = opts.reason
      || `Replied to outreach${campaignName ? ` (${campaignName})` : ''} — follow up today`;
    client.log.push({ at: now, text, kind: 'email', dedupKey });
  }
  await client.save();
  return { ok: true, warmed: true, logged: !already };
}

// Flip ONE enrollment + its company to the warm/replied state. `enr` is a LIVE
// Mongoose doc (the caller saves nothing else). Stops the drip on an
// active/completed enrollment; a terminal one keeps its status but the company
// still warms so a late reply never gets lost.
async function warmFromEnrollment(enr, opts = {}) {
  if (!enr) return { ok: false, reason: 'no-enrollment' };
  const now = opts.now instanceof Date ? opts.now : new Date();
  if (enr.status === 'active' || enr.status === 'completed') {
    enr.status = 'replied';
    enr.repliedAt = enr.repliedAt || now;
    enr.nextSendAt = null;
    await enr.save();
  } else if (enr.status === 'replied' && !enr.repliedAt) {
    enr.repliedAt = now;
    await enr.save();
  }
  const res = await warmCompany(enr.companyKey, {
    ...opts, now, enrollmentId: enr._id, campaignId: enr.campaignId,
  });
  return { ok: true, companyKey: enr.companyKey, ...res };
}

// The CORRECTION for a false warm: an auto-responder slipped past the
// classifier, warmed the company, and stopped the drip — the owner (or the
// re-triage healer) says "that wasn't a real reply". Undo exactly what the
// handoff did, conservatively:
//   • enrollment 'replied' → back to 'active' with the next touch ~an hour out
//     (the sequence resumes where it stopped);
//   • the 'warm' tag comes off; the follow-up we set is cleared (only when it
//     still sits at/behind the warm date — an owner-moved date is respected);
//   • stage reverts contacted → lead ONLY when our warm log line exists and
//     the log shows no real human touch (visit/call) — never regress real work;
//   • our "Replied to outreach" log line is rewritten as a correction, not
//     deleted (history stays honest).
// Idempotent: running it twice is a no-op.
async function unwarmFromReply({ enrollmentId = null, companyKey = '' } = {}, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const OutreachEnrollment = require('../models/OutreachEnrollment');
  let enr = null;
  if (enrollmentId) {
    enr = await OutreachEnrollment.findById(enrollmentId);
    if (enr && enr.status === 'replied') {
      enr.status = 'active';
      enr.repliedAt = null;
      enr.nextSendAt = new Date(now.getTime() + 60 * 60 * 1000);
      await enr.save();
    }
  }
  const key = companyKey || (enr && enr.companyKey) || '';
  if (!key) return { ok: true, unwarmed: false };
  const client = await Client.findOne({ companyKey: key });
  if (!client) return { ok: true, unwarmed: false };

  const dedupKey = enrollmentId ? `outreach-reply:${enrollmentId}` : `outreach-reply:${key}`;
  const line = (client.log || []).find((l) => l && l.dedupKey === dedupKey);
  if (!line) return { ok: true, unwarmed: false }; // we never warmed this one

  client.tags = (client.tags || []).filter((t) => String(t).toLowerCase() !== 'warm');
  if (client.nextFollowUp && line.at && client.nextFollowUp <= new Date(new Date(line.at).getTime() + 26 * 60 * 60 * 1000)) {
    client.nextFollowUp = null;
  }
  const humanTouch = (client.log || []).some((l) => l && l !== line && ['visit', 'call', 'meeting'].includes(l.kind));
  if (client.stage === 'contacted' && !humanTouch) client.stage = 'lead';
  if (!/corrected/i.test(line.text || '')) {
    line.text = 'Auto-responder misread as a real reply — corrected (drip resumed)';
    line.kind = 'note';
  }
  client.markModified('log');
  await client.save();
  return { ok: true, unwarmed: true };
}

module.exports = { warmCompany, warmFromEnrollment, unwarmFromReply };
