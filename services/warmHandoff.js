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

// The mirror of warmFromEnrollment: the lead answered, and the answer was NO.
//
// warmFromEnrollment moves an enrollment to 'replied', and that status is the
// ONLY thing that renders a card under "Warm leads". So a warm card can only be
// cleared by something that moves the enrollment OUT of 'replied' — and the
// triage side-effects scoped their write to `{ status: 'active' }`, which
// matches zero rows once the lead has replied. Marking a reply "Not a lead" was
// therefore a no-op on the one record the card is built from: the owner told the
// system a shop wasn't interested, replied to them by hand, and the card sat
// there anyway with no button that could remove it.
//
// Terminates from any NON-TERMINAL status so it works whether the lead replied
// (the case that was broken), is mid-sequence, or already finished it.
// Idempotent — a row already stopped/unsubscribed/failed is left exactly as is,
// so this can never overwrite a truer terminal reason with a vaguer one.
const CLOSEABLE = ['active', 'replied', 'completed'];
async function closeWarm({ enrollmentId = null, companyKey = '', reason = 'triage-not-interested' } = {}) {
  const OutreachEnrollment = require('../models/OutreachEnrollment');
  const filter = { status: { $in: CLOSEABLE } };
  if (enrollmentId) filter._id = enrollmentId;
  else if (companyKey) filter.companyKey = companyKey;
  else return { closed: 0 };
  const res = await OutreachEnrollment.updateMany(
    filter,
    { $set: { status: 'stopped', stopReason: reason, nextSendAt: null } },
  ).catch(() => ({ modifiedCount: 0 }));
  return { closed: res.modifiedCount || 0 };
}

// The END of the outreach relationship in the good direction: this lead said
// yes, so turn it into a real job.
//
// The pieces already existed — ensureProjectForCompany mints the project and
// promotes the CRM record, ensureDealForProject opens the pipeline card, and the
// CRM's "Start new job" button wires them together — but nothing connected them
// to a REPLY. Converting a warm lead meant reading the reply in the Outreach tab,
// remembering the shop's name, finding it in the CRM, and pressing Start new job
// there, with the enrollment left running in the background the whole time.
//
// So this is that same handoff, reachable from the reply itself, with the two
// things the manual route forgot: the drip STOPS (a lead you're now quoting must
// never get touch 3), and the contact who actually wrote to us is carried onto
// the project instead of whatever generic address the campaign mailed.
//
// Idempotent by construction: ensureProjectForCompany reuses the company's live
// project unless the caller forces a new one, ensureDealForProject reuses the
// deal, and the log line is dedupKey'd — so a double-tap opens one job.
async function convertToJob({
  companyKey = '', enrollmentId = null, contactEmail = '', contactName = '',
  title = '', value = 0, reuse = true, reason = '',
} = {}, opts = {}) {
  const key = String(companyKey || '').trim();
  if (!key) return { ok: false, reason: 'no-company' };
  const now = opts.now instanceof Date ? opts.now : new Date();

  const client = await Client.findOne({ companyKey: key })
    .select('companyKey companyName clientName dealValue log').lean();
  const { ensureProjectForCompany, ensureDealForProject } = require('../controllers/orders');

  const { order, created } = await ensureProjectForCompany({
    companyKey: key,
    companyName: String((client && client.companyName) || '').trim(),
    clientName: String((client && client.clientName) || '').trim(),
    contactName: String(contactName || '').trim(),
    contactEmail: String(contactEmail || '').trim(),
    dealValue: Number(value) || Number((client && client.dealValue) || 0) || 0,
  }, { forceNew: !reuse });

  const deal = await ensureDealForProject(order, {
    title: String(title || '').trim().slice(0, 200),
    value: Number(value) || 0,
  }).catch((e) => { console.warn('[warm] deal card skipped:', e.message); return null; });

  // The drip is over for this company — they're a job now, not a prospect.
  const closed = await closeWarm({ enrollmentId, companyKey: key, reason: 'converted-to-job' });

  // One durable line in the CRM history tying the project back to the reply that
  // produced it, so the funnel stays readable months later.
  const projectNumber = String(order.projectNumber || '');
  const dedupKey = `outreach-job:${projectNumber || order._id}`;
  if (client && !(client.log || []).some((l) => l && l.dedupKey === dedupKey)) {
    await Client.updateOne(
      { companyKey: key },
      {
        $push: {
          log: {
            at: now,
            text: reason || `Outreach reply converted to project #${projectNumber} — quoting`,
            kind: 'email',
            dedupKey,
          },
        },
      },
    ).catch(() => {});
  }

  return {
    ok: true,
    companyKey: key,
    projectNumber,
    orderNumber: String(order.orderNumber || ''),
    orderId: String(order._id || ''),
    dealId: deal ? String(deal._id || '') : '',
    created,
    stoppedSequences: closed.closed || 0,
  };
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

module.exports = {
  closeWarm, convertToJob, warmCompany, warmFromEnrollment, unwarmFromReply };
