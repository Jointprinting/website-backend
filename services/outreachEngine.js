// services/outreachEngine.js
//
// The cold-outreach sender: walks active OutreachEnrollments through their
// campaign's step sequence, at a deliberately SLOW, deliverability-safe pace.
// Scheduling pattern matches services/jpwScheduler.js (same node-cron dep;
// started from server.js on the Mongo 'open' event).
//
// Pace & safety (the whole point — this is cold email, not a newsletter):
//   • Sends only inside business hours, Mon–Fri 9a–5p US Eastern (utils/time's
//     BUSINESS_TZ) — a cron tick every 15 min sends a small batch, so the day's
//     volume is spread out instead of one robotic burst.
//   • A DAILY CAP with a warm-up ramp anchored to the first-ever send
//     (OutreachState.firstSendAt): 10/day week one, +10 each week, topping out
//     at OUTREACH_DAILY_CAP (default 40). A fresh sending identity builds
//     reputation instead of tripping spam filters.
//   • HARD REQUIREMENT: OUTREACH_EMAIL_FROM must be set. The engine never
//     falls back to the main EMAIL_FROM transactional identity — cold volume
//     must not ride (or risk) the owner's real domain.
//   • Per-company guards re-checked against the LIVE Client at send time:
//     doNotEmail, archived, closed/parked stage, became a customer → stop.
//   • CAN-SPAM footer on every send: postal address + unsubscribe link (plus
//     List-Unsubscribe headers when OUTREACH_PUBLIC_API_BASE is configured).
//
// Every send is written back into the CRM: a log touch (kind 'email') on the
// company, lastContact bumped, stage nudged lead→contacted via the same
// promoteStage the rest of the system uses — so Today/Pipeline/heads-up all
// see outreach activity with zero extra wiring.

const cron = require('node-cron');
const crypto = require('crypto');
const OutreachCampaign = require('../models/OutreachCampaign');
const OutreachEnrollment = require('../models/OutreachEnrollment');
const OutreachState = require('../models/OutreachState');
const Client = require('../models/Client');
const sendEmail = require('../utils/sendEmail');
const { promoteStage } = require('../controllers/crm');
const { BUSINESS_TZ, etStartOfToday } = require('../utils/time');

const DAILY_CAP_MAX  = parseInt(process.env.OUTREACH_DAILY_CAP || '150', 10);
const BATCH_PER_TICK = parseInt(process.env.OUTREACH_BATCH_PER_TICK || '5', 10);
// Physical postal address for the CAN-SPAM footer — set the real one in env.
const POSTAL_ADDRESS = process.env.OUTREACH_POSTAL_ADDRESS || 'Joint Printing · New Jersey, USA';
// Public base URL of THIS API (e.g. https://api.jointprinting.com) — powers the
// unsubscribe link + open pixel. Without it we fall back to reply-to-opt-out
// wording (still compliant) and skip open tracking.
const PUBLIC_BASE = String(process.env.OUTREACH_PUBLIC_API_BASE || '').replace(/\/+$/, '');

const outreachFrom    = () => process.env.OUTREACH_EMAIL_FROM || '';
const outreachReplyTo = () => process.env.OUTREACH_REPLY_TO || '';
const smtpConfigured  = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER);

// ── Pure helpers (unit-tested in services/__tests__/outreach.test.js) ─────────

// Warm-up ramp: the allowed sends/day, given how many days ago the first-ever
// send happened. DOUBLES each week — 10 → 20 → 40 → 80 → 160 … — capped at
// `maxCap` (OUTREACH_DAILY_CAP). Starting low and doubling is the reputation-safe
// way to scale hard: a brand-new sending domain that opens at 150/day gets
// flagged, but one that climbs 10→20→40→80 over a month arrives at volume with a
// clean reputation. Raise OUTREACH_DAILY_CAP as high as your SMTP plan's daily
// limit allows; the ramp will climb to it and hold. No first send yet → week-one.
function rampCap(daysSinceFirstSend, maxCap = DAILY_CAP_MAX) {
  const days = Number.isFinite(daysSinceFirstSend) && daysSinceFirstSend >= 0
    ? daysSinceFirstSend : 0;
  const week = Math.floor(days / 7);
  const geometric = 10 * Math.pow(2, week); // 10, 20, 40, 80, 160, 320, …
  return Math.min(geometric, maxCap);
}

// Send window: Mon–Fri, 9:00–16:59 in the business timezone. Emails that land
// during a workday morning read human; 3am blasts read like a bot.
function isWithinSendWindow(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TZ, weekday: 'short', hour: 'numeric', hourCycle: 'h23',
  });
  const parts = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  const weekday = parts.weekday;                 // 'Mon' … 'Sun'
  const hour = parseInt(parts.hour, 10);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return hour >= 9 && hour < 17;
}

// {{field}} / {{field|fallback}} merge rendering. Unknown/empty fields render
// as the fallback (or ''), so a template never leaks braces into a real email.
function renderTemplate(tpl, ctx = {}) {
  return String(tpl || '').replace(
    /\{\{\s*([A-Za-z][\w]*)\s*(?:\|([^}]*))?\}\}/g,
    (_, key, fallback) => {
      const v = ctx[key];
      const s = v == null ? '' : String(v).trim();
      return s !== '' ? s : String(fallback || '').trim();
    },
  );
}

// Best-effort city from an exact street address ("123 Main St, Newark NJ 07102"
// or "123 Main St, Newark, NJ 07102" → "Newark"). '' when it can't tell — pair
// with a template fallback: {{city|your area}}.
function cityFromAddress(address) {
  const parts = String(address || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return '';
  // Second segment is the city ("Newark NJ 07102" or just "Newark"). Strip a
  // trailing "ST 12345[-6789]" / bare state / bare zip.
  let city = parts[1]
    .replace(/\b[A-Z]{2}\b\.?\s*\d{5}(?:-\d{4})?\s*$/, '')
    .replace(/\b[A-Z]{2}\b\.?\s*$/, '')
    .replace(/\d{5}(?:-\d{4})?\s*$/, '')
    .trim();
  // "123 Main St, 2nd Floor, Newark, NJ" — if segment 2 still looks like a unit
  // ("Suite 4", "Floor 2") and there's a later segment, try the next one.
  if (/\d/.test(city) && parts.length >= 3) {
    const alt = parts[2].replace(/\b[A-Z]{2}\b\.?\s*\d{5}(?:-\d{4})?\s*$/, '').replace(/\b[A-Z]{2}\b\.?\s*$/, '').trim();
    if (alt && !/\d/.test(alt)) return alt;
  }
  return /\d/.test(city) ? '' : city;
}

// The merge context for one company — the vocabulary campaign templates write
// against. MIRRORED (as a comment list) in the frontend's outreach/_outreach.js
// MERGE_FIELDS; keep in sync.
function buildMergeContext(client = {}) {
  const contacts = Array.isArray(client.contacts) ? client.contacts : [];
  const personName = String(client.clientName || (contacts[0] && contacts[0].name) || '').trim();
  return {
    companyName: String(client.companyName || client.clientName || '').trim(),
    clientName:  personName,
    firstName:   personName.split(/\s+/)[0] || '',
    city:        cityFromAddress(client.address || client.area),
  };
}

const escapeHtml = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Plain-text body → simple, human-looking HTML (paragraphs + line breaks). No
// heavy markup on purpose: text-like emails deliver and read better cold.
function bodyToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((para) => `<p style="margin:0 0 1em 0;">${escapeHtml(para).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

const unsubscribeUrl = (token) => (PUBLIC_BASE ? `${PUBLIC_BASE}/api/outreach/u/${token}` : '');
const openPixelUrl   = (token) => (PUBLIC_BASE ? `${PUBLIC_BASE}/api/outreach/t/${token}/open.png` : '');

// Full HTML + plain-text message for one send: rendered body, CAN-SPAM footer
// (postal address + opt-out), and the open pixel when a public base is set.
function composeMessage({ bodyText, token }) {
  const unsub = unsubscribeUrl(token);
  const optOutHtml = unsub
    ? `Don&#39;t want these? <a href="${unsub}" style="color:#888;">Unsubscribe</a> and we won&#39;t email again.`
    : 'Don&#39;t want these? Reply &quot;unsubscribe&quot; and we&#39;ll take you off the list.';
  const optOutText = unsub
    ? `Don't want these? Unsubscribe: ${unsub}`
    : `Don't want these? Reply "unsubscribe" and we'll take you off the list.`;
  const pixel = openPixelUrl(token);
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;">`,
    bodyToHtml(bodyText),
    `<p style="margin:1.5em 0 0 0;font-size:11px;line-height:1.5;color:#999;">`,
    `${escapeHtml(POSTAL_ADDRESS)}<br>${optOutHtml}</p>`,
    pixel ? `<img src="${pixel}" width="1" height="1" alt="" style="display:none;">` : '',
    `</div>`,
  ].join('');
  const text = `${String(bodyText || '')}\n\n--\n${POSTAL_ADDRESS}\n${optOutText}\n`;
  return { html, text };
}

// Why a LIVE Client must not be emailed right now ('' = fine to send). The
// engine re-checks this at send time so owner edits always win over whatever
// was true at enroll time.
function sendBlockReason(client) {
  if (!client || client.archived) return 'archived';
  if (client.doNotEmail) return 'do-not-email';
  const stage = client.stage || 'lead';
  if (stage === 'lost' || stage === 'dormant') return 'closed-stage';
  if (stage === 'won' || stage === 'customer') return 'became-customer';
  return '';
}

// First usable email for a company: its own, else the first contact's.
function pickEmail(client = {}) {
  const own = String(client.email || '').trim();
  if (own) return own;
  const c = (Array.isArray(client.contacts) ? client.contacts : []).find((x) => x && String(x.email || '').trim());
  return c ? String(c.email).trim() : '';
}

const newToken = () => crypto.randomBytes(16).toString('hex');

// Is an SMTP send error PERMANENT (the address is bad) vs. temporary (greylist,
// timeout, rate limit)? A permanent failure should suppress the address; a
// temporary one should be retried. Reads the SMTP response code and the message
// text (nodemailer surfaces both). Pure + unit-tested.
function isPermanentSmtpError(err) {
  if (!err) return false;
  const code = Number(err.responseCode != null ? err.responseCode : err.code);
  if (Number.isFinite(code) && code >= 500 && code < 600) return true;
  const msg = String(err.message || err.response || '').toLowerCase();
  if (/\b5\.\d\.\d\b/.test(msg)) return true; // enhanced status code 5.x.x
  return /(no such (user|recipient|mailbox|address)|user unknown|mailbox (unavailable|not found|does not exist)|recipient (address )?rejected|address rejected|does not exist|invalid recipient|account (is )?(disabled|closed)|relay access denied)/.test(msg);
}

// ── Engine ───────────────────────────────────────────────────────────────────

async function countSentSince(since) {
  const rows = await OutreachEnrollment.aggregate([
    { $match: { 'sends.at': { $gte: since } } },
    { $project: { n: { $size: { $filter: { input: '$sends', as: 's', cond: { $gte: ['$$s.at', since] } } } } } },
    { $group: { _id: null, total: { $sum: '$n' } } },
  ]);
  return rows.length ? rows[0].total : 0;
}

// Engine status snapshot for the Studio (Outreach tab header + overview).
async function engineStatus(now = new Date()) {
  const state = await OutreachState.findOne({ key: 'engine' }).lean();
  const firstSendAt = state && state.firstSendAt ? state.firstSendAt : null;
  const daysSince = firstSendAt ? Math.floor((now - new Date(firstSendAt)) / 86400000) : null;
  const cap = rampCap(daysSince == null ? 0 : daysSince, DAILY_CAP_MAX);
  const sentToday = await countSentSince(etStartOfToday(now));
  return {
    senderConfigured: !!outreachFrom(),
    smtpConfigured: smtpConfigured(),
    from: outreachFrom(),
    withinWindow: isWithinSendWindow(now),
    firstSendAt,
    rampWeek: firstSendAt ? Math.floor((daysSince || 0) / 7) + 1 : 1,
    dailyCap: cap,
    dailyCapMax: DAILY_CAP_MAX,
    sentToday,
    remainingToday: Math.max(0, cap - sentToday),
    publicLinksConfigured: !!PUBLIC_BASE,
    lastRunAt: state ? state.last_run_at : null,
    lastResult: state ? state.last_result : '',
  };
}

async function recordRun(result) {
  await OutreachState.findOneAndUpdate(
    { key: 'engine' },
    { $set: { last_run_at: new Date(), last_result: result } },
    { upsert: true },
  ).catch((e) => console.warn('[outreach] state write failed:', e.message));
}

// Send ONE enrollment's next due step. Returns 'sent' | 'skipped' | 'error'.
async function sendOne(enr, campaign, now = new Date()) {
  const client = await Client.findOne({ companyKey: enr.companyKey });

  // Live-guard: stop (don't send) when the company left cold-outreach land.
  const block = sendBlockReason(client);
  if (block) {
    enr.status = block === 'do-not-email' ? 'unsubscribed' : 'stopped';
    enr.stopReason = block;
    if (block === 'do-not-email') enr.unsubscribedAt = now;
    await enr.save();
    return 'skipped';
  }

  const to = pickEmail(client) || enr.toEmail;
  if (!to) {
    enr.status = 'stopped';
    enr.stopReason = 'no-email';
    await enr.save();
    return 'skipped';
  }

  const step = (campaign.steps || [])[enr.stepIndex];
  if (!step) {
    enr.status = 'completed';
    await enr.save();
    return 'skipped';
  }

  const ctx = buildMergeContext(client);
  // Merge values come from client records — collapse any stray newlines so a
  // weird companyName can never smuggle extra SMTP headers via the subject.
  const subject = (renderTemplate(step.subject, ctx).replace(/[\r\n]+/g, ' ').trim())
    || `Quick question for ${ctx.companyName || 'you'}`;
  const bodyText = renderTemplate(step.body, ctx);
  const { html, text } = composeMessage({ bodyText, token: enr.token });

  const unsub = unsubscribeUrl(enr.token);
  const headers = unsub
    ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : undefined;

  try {
    const info = await sendEmail({
      to, subject, html, textAlt: text, headers,
      from: outreachFrom(),
      ...(outreachReplyTo() ? { replyTo: outreachReplyTo() } : {}),
    });

    // Advance the enrollment.
    enr.sends.push({ stepIndex: enr.stepIndex, at: now, subject, messageId: (info && info.messageId) || '' });
    enr.toEmail = to;
    enr.sendAttempts = 0;
    enr.lastError = '';
    const nextIndex = enr.stepIndex + 1;
    const nextStep = (campaign.steps || [])[nextIndex];
    if (nextStep) {
      enr.stepIndex = nextIndex;
      const offset = Math.max(1, Number(nextStep.offsetDays) || 1);
      enr.nextSendAt = new Date(now.getTime() + offset * 86400000);
    } else {
      enr.status = 'completed';
      enr.nextSendAt = null;
    }
    await enr.save();

    // Anchor the warm-up ramp on the first-ever send.
    await OutreachState.findOneAndUpdate(
      { key: 'engine', $or: [{ firstSendAt: null }, { firstSendAt: { $exists: false } }] },
      { $set: { firstSendAt: now } },
      { upsert: false },
    ).catch(() => {});
    await OutreachState.findOneAndUpdate(
      { key: 'engine' },
      { $setOnInsert: { firstSendAt: now } },
      { upsert: true },
    ).catch(() => {});

    // Write the touch back into the CRM so every surface sees it.
    const stepNo = `${enr.sends.length ? enr.sends[enr.sends.length - 1].stepIndex + 1 : 1}/${(campaign.steps || []).length}`;
    client.log.push({
      at: now,
      text: `Cold email sent — “${subject}” (${campaign.name} · step ${stepNo})`,
      kind: 'email',
      dedupKey: `outreach:${enr._id}:${enr.sends[enr.sends.length - 1].stepIndex}`,
    });
    client.lastContact = now;
    client.stage = promoteStage(client.stage, 'contacted');
    await client.save();

    return 'sent';
  } catch (err) {
    enr.sendAttempts = (enr.sendAttempts || 0) + 1;
    enr.lastError = String(err.message || err).slice(0, 500);
    // A PERMANENT rejection (5xx / "no such user") means the address is dead —
    // retrying just burns the daily cap and dents reputation. Stop this
    // enrollment AND flag the company doNotEmail so no OTHER campaign wastes a
    // send on it either. (Temporary 4xx errors fall through to the retry path.)
    if (isPermanentSmtpError(err)) {
      enr.status = 'failed';
      enr.stopReason = 'invalid-address';
      enr.nextSendAt = null;
      await enr.save();
      await Client.updateOne(
        { companyKey: enr.companyKey, doNotEmail: { $ne: true } },
        {
          $set: { doNotEmail: true },
          $push: { log: { at: now, text: 'Email address rejected (bounced) — suppressed from outreach', kind: 'email', dedupKey: `outreach-bounce:${enr._id}` } },
        },
      ).catch(() => {});
      console.warn(`[outreach] permanent bounce for ${enr.companyKey} (${to}) — suppressed`);
      return 'skipped';
    }
    if (enr.sendAttempts >= 3) {
      enr.status = 'failed';
      enr.stopReason = 'smtp-error';
    }
    await enr.save();
    console.error(`[outreach] send failed for ${enr.companyKey}:`, err.message);
    return 'error';
  }
}

// One engine tick: window → cap → due batch. Exported for tests + a manual
// "run now" trigger from the Studio.
async function runOutreachTick(now = new Date()) {
  if (!smtpConfigured()) return { skipped: 'smtp-not-configured' };
  if (!outreachFrom())   return { skipped: 'sender-not-configured' };
  if (!isWithinSendWindow(now)) return { skipped: 'outside-window' };

  const campaigns = await OutreachCampaign.find({ status: 'active' }).lean();
  if (!campaigns.length) return { skipped: 'no-active-campaigns' };
  const byId = new Map(campaigns.map((c) => [String(c._id), c]));

  const state = await OutreachState.findOne({ key: 'engine' }).lean();
  const daysSince = state && state.firstSendAt
    ? Math.floor((now - new Date(state.firstSendAt)) / 86400000) : null;
  const cap = rampCap(daysSince == null ? 0 : daysSince, DAILY_CAP_MAX);
  const sentToday = await countSentSince(etStartOfToday(now));
  const budget = Math.min(cap - sentToday, BATCH_PER_TICK);
  if (budget <= 0) return { skipped: 'daily-cap', cap, sentToday };

  // Oldest-due first; fetch slack beyond the budget since some will be
  // guard-skipped rather than sent.
  const due = await OutreachEnrollment.find({
    status: 'active',
    campaignId: { $in: campaigns.map((c) => c._id) },
    nextSendAt: { $lte: now },
  }).sort({ nextSendAt: 1 }).limit(budget * 4);

  let sent = 0, skipped = 0, errors = 0;
  for (const enr of due) {
    if (sent >= budget) break;
    const campaign = byId.get(String(enr.campaignId));
    if (!campaign) continue;
    const r = await sendOne(enr, campaign, now);
    if (r === 'sent') sent += 1;
    else if (r === 'skipped') skipped += 1;
    else errors += 1;
  }
  const result = `sent ${sent}, skipped ${skipped}, errors ${errors} (cap ${cap}, sentToday ${sentToday + sent})`;
  if (sent || skipped || errors) {
    console.log(`[outreach] tick: ${result}`);
    await recordRun(result);
  }
  return { sent, skipped, errors, cap, sentToday: sentToday + sent };
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
function startOutreachEngine() {
  // Every 15 minutes; the tick itself gates on the ET business-hours window,
  // so UTC/DST drift can never move the send window.
  cron.schedule('*/15 * * * *', () => {
    runOutreachTick().catch((e) => console.error('[outreach] tick error:', e.message));
  });
  console.log(
    outreachFrom()
      ? `[outreach] engine started — window Mon–Fri 9a–5p ET, cap ramps to ${DAILY_CAP_MAX}/day, from ${outreachFrom()}`
      : '[outreach] engine started — HOLDING (set OUTREACH_EMAIL_FROM to enable sends; the main EMAIL_FROM is never used for cold outreach)',
  );
}

module.exports = {
  startOutreachEngine,
  runOutreachTick,
  engineStatus,
  sendOne,
  newToken,
  pickEmail,
  // pure helpers (unit-tested)
  rampCap,
  isWithinSendWindow,
  renderTemplate,
  buildMergeContext,
  cityFromAddress,
  composeMessage,
  sendBlockReason,
  bodyToHtml,
  isPermanentSmtpError,
  DAILY_CAP_MAX,
};
