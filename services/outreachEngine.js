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
//     (OutreachState.firstSendAt): 10/day week one, then DOUBLING weekly
//     (10 → 20 → 40 → …) until it holds at OUTREACH_DAILY_CAP (default 50 — a
//     reputation-safe ceiling for ONE inbox). A fresh sending identity builds
//     reputation instead of tripping spam filters. Sends are also paced with
//     per-send jitter + a per-domain cap so the day's volume never lands as one
//     robotic burst.
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
const Suppression = require('../models/Suppression');
const Client = require('../models/Client');
const sendEmail = require('../utils/sendEmail');
const { promoteStage } = require('../controllers/crm');
const { suppress, isSuppressed, isEmail } = require('./suppression');
const { applySpintax } = require('./outreachContent');
const { getSenders } = require('./senderPool');
const { getAuthStatus } = require('../utils/dnsAuth');
const { BUSINESS_TZ, etStartOfToday, etToday } = require('../utils/time');

// Hold cold sends when the sender domain is missing SPF/DMARC (the Gmail/Yahoo
// bulk-sender essentials) — the same "don't send blind" stance as the
// OUTREACH_EMAIL_FROM hold. Set OUTREACH_DMARC_GATE=off to disable (advisory-only).
const authGateEnabled = () => process.env.OUTREACH_DMARC_GATE !== 'off';

// The person the outreach signs off as — used by the {{senderName}} merge token
// so the sign-off isn't hardcoded in every template body.
const outreachSenderName = () => process.env.OUTREACH_SENDER_NAME || 'Nate';

// US states, for the {{state}} merge token parsed from a stored address. (Kept
// local to avoid importing the controller — which imports this engine.)
const US_STATES = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY',
  'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV',
  'WI', 'WY', 'DC',
]);
function stateFromAddress(address) {
  const s = String(address || '').trim();
  let m = s.match(/\b([A-Za-z]{2})\s+\d{5}(?:-\d{4})?\s*$/); // "NJ 07102"
  if (m && US_STATES.has(m[1].toUpperCase())) return m[1].toUpperCase();
  m = s.match(/,\s*([A-Za-z]{2})\.?\s*$/); // trailing ", NJ"
  if (m && US_STATES.has(m[1].toUpperCase())) return m[1].toUpperCase();
  return '';
}

// A sane default for ONE fresh sending inbox. The ramp climbs to it over weeks
// (rampCap); raise OUTREACH_DAILY_CAP as your SMTP plan + a warmed reputation
// allow. 50 (not 150) is the reputation-safe ceiling for a single identity.
const DAILY_CAP_MAX  = parseInt(process.env.OUTREACH_DAILY_CAP || '50', 10);
const BATCH_PER_TICK = parseInt(process.env.OUTREACH_BATCH_PER_TICK || '5', 10);
// No single recipient domain gets hammered in one day (a chain's shared inbox,
// or a clump of gmail.com leads) — protects both them and our reputation.
const DOMAIN_DAILY_CAP = parseInt(process.env.OUTREACH_DOMAIN_DAILY_CAP || '15', 10);
// How long a claimed (leased) row is hidden from other workers before it's
// eligible again — crash-safety without permanently stranding a row.
const LEASE_MS = parseInt(process.env.OUTREACH_LEASE_MS || String(10 * 60 * 1000), 10);
// Inter-send pacing jitter (cron path only) — breaks the "all at :00:00" burst.
const PACE_MIN_MS = 5000;
const PACE_MAX_MS = 20000;
// Physical postal address for the CAN-SPAM footer — set the real one in env.
const POSTAL_ADDRESS = process.env.OUTREACH_POSTAL_ADDRESS || 'Joint Printing · New Jersey, USA';
// Public base URL of THIS API (e.g. https://api.jointprinting.com) — powers the
// unsubscribe link + open pixel. Without it we fall back to reply-to-opt-out
// wording (still compliant) and skip open tracking.
const PUBLIC_BASE = String(process.env.OUTREACH_PUBLIC_API_BASE || '').replace(/\/+$/, '');

// The primary from-address (first identity in the sender pool) — used for the
// auth check + status display. The pool (services/senderPool.js) resolves to the
// legacy single identity when OUTREACH_SENDERS is unset, so this stays correct.
const outreachFrom    = () => (getSenders()[0] || {}).from || process.env.OUTREACH_EMAIL_FROM || '';
const outreachReplyTo = () => process.env.OUTREACH_REPLY_TO || '';
const globalSmtpSet   = () => !!(process.env.SMTP_HOST && process.env.SMTP_USER);
// Sendable when there's at least one identity that has a usable transport
// (its own per-identity SMTP, or the shared global SMTP_* one).
const smtpConfigured  = () => {
  const senders = getSenders();
  if (!senders.length) return globalSmtpSet();
  return senders.some((s) => s.smtp || globalSmtpSet());
};

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

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const domainOfEmail = (e) => { const s = String(e || '').trim().toLowerCase(); const i = s.lastIndexOf('@'); return i >= 0 ? s.slice(i + 1) : ''; };

// Back-off schedule for a TRANSIENT SMTP error (greylist, timeout, rate limit):
// 30m → 2h → 6h → 6h… so one temporary hiccup can't burn all attempts in ~45
// min and permanently fail a good lead (the audited bug). PURE. Returns ms.
function transientBackoffMs(attempts = 1) {
  const ladder = [30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000];
  const i = Math.max(0, Math.min(ladder.length - 1, Math.round(attempts) - 1));
  return ladder[i];
}

// A follow-up's due time: base day + offsetDays, JITTERED off the exact
// wall-clock minute so touch N+1 never lands at the identical time as touch N
// (the send-window gate still holds it to business hours). `rand` ∈ [0,1) is
// injected so it's PURE + unit-tested. Spreads ±~3h around the target.
function jitteredFollowUpAt(base, offsetDays, rand = 0.5) {
  const b = base instanceof Date ? base.getTime() : Number(base) || Date.now();
  const days = Math.max(1, Number(offsetDays) || 1);
  const jitter = Math.round((rand - 0.5) * 6 * 60 * 60 * 1000); // ±3h
  return new Date(b + days * 86400000 + jitter);
}

// Vary the per-tick batch size around BATCH_PER_TICK so the burst size isn't a
// constant fingerprint. `rand` ∈ [0,1) injected → PURE. Range [base-1, base+2],
// floored at 1.
function variableBatch(base = BATCH_PER_TICK, rand = 0.5) {
  const b = Math.max(1, Math.round(base));
  const delta = Math.floor(rand * 4) - 1; // -1..+2
  return Math.max(1, b + delta);
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
//
// `greeting` is the smart opener: "Hey Sam," when we have a first name, plain
// "Hey," when we don't (scraped shops rarely carry a person) — never a stilted
// "Hey there," and never a broken "Hey ,". Templates open with {{greeting}}.
function buildMergeContext(client = {}) {
  const contacts = Array.isArray(client.contacts) ? client.contacts : [];
  const personName = String(client.clientName || (contacts[0] && contacts[0].name) || '').trim();
  const firstName = personName.split(/\s+/)[0] || '';
  return {
    companyName: String(client.companyName || client.clientName || '').trim(),
    clientName:  personName,
    firstName,
    greeting:    firstName ? `Hey ${firstName},` : 'Hey,',
    city:        cityFromAddress(client.address || client.area),
    state:       stateFromAddress(client.address || client.area),
    senderName:  outreachSenderName(),
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

// Both are keyed by the enrollment token; with no token (e.g. the wizard's
// tokenless test send) they return '' so composeMessage falls back to the
// reply-based opt-out and skips the pixel — never a broken /u/ or /open.png link.
const unsubscribeUrl = (token) => (PUBLIC_BASE && token ? `${PUBLIC_BASE}/api/outreach/u/${token}` : '');
const openPixelUrl   = (token) => (PUBLIC_BASE && token ? `${PUBLIC_BASE}/api/outreach/t/${token}/open.png` : '');
// Open tracking is OFF by default: a hidden 1×1 pixel is a classic tracker
// fingerprint and Apple Mail Privacy Protection makes opens near-meaningless
// anyway. Set OUTREACH_OPEN_PIXEL=on to re-enable (then it's a plain 1×1, not
// display:none). Replies/clicks are the signals that matter.
const openPixelEnabled = () => process.env.OUTREACH_OPEN_PIXEL === 'on';
// The address a mailto: List-Unsubscribe points at (fuller CAN-SPAM / bulk-sender
// compliance alongside the https one-click). Falls back to the reply-to / from.
const unsubMailtoAddr = () => {
  const raw = process.env.OUTREACH_UNSUB_MAILTO || outreachReplyTo() || outreachFrom() || '';
  const m = String(raw).match(/[^<>\s@]+@[^<>\s@]+/);
  return m ? m[0] : '';
};

// Stable Message-ID for one (enrollment, step) — the SAME id on a crash-retry of
// that step, so the provider dedupes a double-send, and follow-ups can thread to
// it via In-Reply-To/References (Wave 4). Domain taken from the sending identity.
function outreachMessageId(enr, stepIndex) {
  const dom = domainOfEmail(outreachFrom()) || 'jointprinting.com';
  return `<outreach-${enr._id}-${stepIndex}@${dom}>`;
}

// Strip any leading "Re:" chain so a threaded follow-up subject is exactly
// "Re: <original>", never "Re: Re: Re: <original>".
const stripRePrefix = (s) => String(s || '').replace(/^(?:\s*re\s*:\s*)+/i, '').trim();

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
  const pixel = openPixelEnabled() ? openPixelUrl(token) : '';
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222;">`,
    bodyToHtml(bodyText),
    `<p style="margin:1.5em 0 0 0;font-size:11px;line-height:1.5;color:#999;">`,
    `${escapeHtml(POSTAL_ADDRESS)}<br>${optOutHtml}</p>`,
    pixel ? `<img src="${pixel}" width="1" height="1" alt="">` : '', // no display:none
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

// Role-inbox local-parts — a named person is a far better cold-outreach target
// than a shared "info@/sales@" alias (higher reply rate, less likely a
// catch-all). Used to rank candidate addresses in pickEmail.
const ROLE_LOCALS = new Set([
  'info', 'sales', 'contact', 'admin', 'hello', 'orders', 'order', 'support',
  'office', 'team', 'mail', 'marketing', 'general', 'inquiries', 'inquiry',
  'help', 'service', 'noreply', 'no-reply', 'donotreply', 'webmaster', 'store',
]);
function isRoleEmail(email) {
  const local = String(email || '').toLowerCase().split('@')[0] || '';
  return ROLE_LOCALS.has(local.replace(/[.+_-].*$/, '')); // "sales.team" / "info+nj" → role
}

// Best usable email for a company: prefer a NAMED person over a role inbox.
// Ranks every candidate (the company's own email + each contact's) by
// non-role + has-a-name, so a buyer's personal address beats info@ when both
// exist — but a role inbox is still returned when it's all we have.
function pickEmail(client = {}) {
  const cands = [];
  const own = String(client.email || '').trim();
  if (own) cands.push({ email: own, name: String(client.clientName || '').trim() });
  for (const c of (Array.isArray(client.contacts) ? client.contacts : [])) {
    const e = String((c && c.email) || '').trim();
    if (e) cands.push({ email: e, name: String((c && c.name) || '').trim() });
  }
  if (!cands.length) return '';
  const score = (c) => (isRoleEmail(c.email) ? 0 : 2) + (c.name ? 1 : 0);
  cands.sort((a, b) => score(b) - score(a));
  return cands[0].email;
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

// O(1) "sent today" (ET). Fast path: read the counter on OutreachState. On a day
// rollover (or first-ever read), seed it ONCE from the authoritative scan so it
// self-heals and can't drift — then every send $inc's it. Replaces re-scanning
// every enrollment's unbounded sends[] on every 15-min tick.
async function getSentToday(now = new Date()) {
  const key = etToday(now);
  const state = await OutreachState.findOne({ key: 'engine' }).select('sentToday sentTodayDate').lean();
  if (state && state.sentTodayDate === key) return state.sentToday || 0;
  const actual = await countSentSince(etStartOfToday(now));
  await OutreachState.findOneAndUpdate(
    { key: 'engine' },
    { $set: { sentTodayDate: key, sentToday: actual } },
    { upsert: true },
  ).catch(() => {});
  return actual;
}

// ── Deliverability circuit-breaker ───────────────────────────────────────────
// Rolling 7-day bounce + complaint rate. Bounces/complaints come from the global
// Suppression list (written by the bounce webhook + permanent-SMTP path);
// denominator is sends in the same window. Cached ~10 min — it's read on every
// tick + dashboard load.
const BREAKER_MIN_SAMPLE = parseInt(process.env.OUTREACH_BREAKER_MIN_SAMPLE || '30', 10);
const MAX_BOUNCE_RATE = parseFloat(process.env.OUTREACH_MAX_BOUNCE_RATE || '0.05');       // 5%
const MAX_COMPLAINT_RATE = parseFloat(process.env.OUTREACH_MAX_COMPLAINT_RATE || '0.002'); // 0.2%
let _dstatsCache = { at: 0, val: null };
const DSTATS_TTL = parseInt(process.env.OUTREACH_DSTATS_TTL_MS || String(10 * 60 * 1000), 10);

async function deliverabilityStats(now = new Date(), { force = false } = {}) {
  const nowMs = now.getTime();
  if (!force && _dstatsCache.val && (nowMs - _dstatsCache.at) < DSTATS_TTL) return _dstatsCache.val;
  const since = new Date(nowMs - 7 * 86400000);
  const [sent7d, bounced7d, complaints7d] = await Promise.all([
    countSentSince(since),
    Suppression.countDocuments({ reason: 'hard-bounce', createdAt: { $gte: since } }).catch(() => 0),
    Suppression.countDocuments({ reason: 'complaint', createdAt: { $gte: since } }).catch(() => 0),
  ]);
  const bounceRate = sent7d > 0 ? bounced7d / sent7d : 0;
  const complaintRate = sent7d > 0 ? complaints7d / sent7d : 0;
  const enoughData = sent7d >= BREAKER_MIN_SAMPLE;
  const tripped = enoughData && (bounceRate > MAX_BOUNCE_RATE || complaintRate > MAX_COMPLAINT_RATE);
  const reason = !tripped ? ''
    : bounceRate > MAX_BOUNCE_RATE
      ? `${(bounceRate * 100).toFixed(1)}% bounce rate (7d) exceeds ${(MAX_BOUNCE_RATE * 100).toFixed(0)}% — clean the list`
      : `${(complaintRate * 100).toFixed(2)}% complaint rate (7d) exceeds ${(MAX_COMPLAINT_RATE * 100).toFixed(2)}%`;
  const val = { sent7d, bounced7d, complaints7d, bounceRate, complaintRate, tripped, reason,
    maxBounceRate: MAX_BOUNCE_RATE, maxComplaintRate: MAX_COMPLAINT_RATE };
  _dstatsCache = { at: nowMs, val };
  return val;
}

// Increment the daily counter by `n` for today's ET day (no-op if the stored day
// already rolled — getSentToday reseeds on the next read).
async function bumpSentToday(n, now = new Date()) {
  if (!n) return;
  await OutreachState.updateOne(
    { key: 'engine', sentTodayDate: etToday(now) },
    { $inc: { sentToday: n } },
  ).catch(() => {});
}

// Today's sends bucketed by recipient DOMAIN → Map(domain → count). One
// aggregation per tick; seeds the per-domain cap so a single domain can't be
// hammered across the day (not just within one tick).
async function sentTodayByDomain(now = new Date()) {
  const since = etStartOfToday(now);
  const rows = await OutreachEnrollment.aggregate([
    { $match: { 'sends.at': { $gte: since }, toEmail: { $ne: '' } } },
    { $project: { toEmail: 1, n: { $size: { $filter: { input: '$sends', as: 's', cond: { $gte: ['$$s.at', since] } } } } } },
  ]);
  const map = new Map();
  for (const r of rows) {
    const dom = domainOfEmail(r.toEmail);
    if (!dom) continue;
    map.set(dom, (map.get(dom) || 0) + (r.n || 0));
  }
  return map;
}

// Today's sends bucketed by sending IDENTITY (senderPool label) → Map(label →
// count). Powers the per-inbox daily cap so a multi-inbox pool sends more safely.
async function sentTodayBySender(now = new Date()) {
  const since = etStartOfToday(now);
  const rows = await OutreachEnrollment.aggregate([
    { $match: { 'sends.at': { $gte: since } } },
    { $unwind: '$sends' },
    { $match: { 'sends.at': { $gte: since } } },
    { $group: { _id: { $ifNull: ['$sends.sender', ''] }, n: { $sum: 1 } } },
  ]);
  const map = new Map();
  for (const r of rows) map.set(r._id || '', r.n || 0);
  return map;
}

// Engine status snapshot for the Studio (Outreach tab header + overview).
async function engineStatus(now = new Date()) {
  const state = await OutreachState.findOne({ key: 'engine' }).lean();
  const firstSendAt = state && state.firstSendAt ? state.firstSendAt : null;
  const daysSince = firstSendAt ? Math.floor((now - new Date(firstSendAt)) / 86400000) : null;
  const days = daysSince == null ? 0 : daysSince;
  const sentToday = await getSentToday(now);

  // Sender pool: per-inbox ramped cap + today's count; total is the sum.
  const pool = getSenders();
  const sentBySender = await sentTodayBySender(now).catch(() => new Map());
  const legacyCount = sentBySender.get('') || 0;
  const senders = pool.map((s, i) => {
    const c = rampCap(days, s.dailyCap);
    const used = (sentBySender.get(s.label) || 0) + (i === 0 ? legacyCount : 0);
    return { label: s.label, from: s.from, cap: c, sentToday: used, remaining: Math.max(0, c - used) };
  });
  const cap = senders.reduce((a, s) => a + s.cap, 0);
  const dailyCapMax = pool.reduce((a, s) => a + s.dailyCap, 0) || DAILY_CAP_MAX;
  const remainingToday = senders.reduce((a, s) => a + s.remaining, 0);
  const fromLabel = pool.length > 1 ? `${pool.length} inboxes (${pool[0].from} +${pool.length - 1})` : outreachFrom();

  const auth = outreachFrom() ? await getAuthStatus(outreachFrom()).catch(() => null) : null;
  const deliverability = await deliverabilityStats(now).catch(() => null);
  return {
    senderConfigured: !!outreachFrom(),
    smtpConfigured: smtpConfigured(),
    from: fromLabel,
    senders,
    senderCount: pool.length,
    auth,
    authGate: authGateEnabled(),
    deliverability,
    withinWindow: isWithinSendWindow(now),
    firstSendAt,
    rampWeek: firstSendAt ? Math.floor(days / 7) + 1 : 1,
    dailyCap: cap,
    dailyCapMax,
    sentToday,
    remainingToday,
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

// One-shot "does my sending actually work" probe for the first-run wizard.
// Renders a tiny sample through the REAL from-identity + SMTP the engine uses
// (the primary pool inbox) and delivers it to the operator's own address, so
// they can confirm the domain authenticates and lands in the inbox — not spam —
// BEFORE enrolling a single lead. No enrollment, no tracking pixel, no CRM write:
// a self-contained diagnostic. Returns { ok, to, from } or throws a plain-English
// error the controller surfaces as a 400.
async function sendTestEmail(to) {
  if (!outreachFrom())   throw new Error('Set OUTREACH_EMAIL_FROM on the API first, then send the test.');
  if (!smtpConfigured()) throw new Error('SMTP isn’t configured on the API yet — set the SMTP_* (or per-sender) credentials.');

  const dest = String(to || '').trim() || outreachFrom();
  if (!isEmail(dest)) throw new Error('Enter a valid email address to send the test to (e.g. your own inbox).');

  const sender = getSenders()[0] || {};
  const fromAddr = sender.from || outreachFrom();
  const replyToAddr = sender.replyTo || outreachReplyTo();
  const auth = await getAuthStatus(fromAddr).catch(() => null);
  const authLine = auth
    ? `Sender auth right now: SPF ${auth.spf ? '✓' : '✗'} · DKIM ${auth.dkim ? '✓' : '✗'} · DMARC ${auth.dmarc ? '✓' : '✗'} (${auth.level}).`
    : 'Sender auth: could not verify DNS just now.';
  const bodyText = [
    'This is a test from your Joint Printing outreach engine.',
    '',
    'If it landed in your inbox (not spam or promotions), your sending address is ready — go ahead and enroll leads.',
    'If it went to spam or never arrived, finish the SPF / DKIM / DMARC setup in docs/DELIVERABILITY.md before starting a campaign.',
    '',
    authLine,
    '',
    `Sent from ${fromAddr}${replyToAddr ? ` · replies go to ${replyToAddr}` : ''}.`,
  ].join('\n');
  const { html, text } = composeMessage({ bodyText, token: '' }); // '' → reply-based opt-out, no pixel

  const info = await sendEmail({
    to: dest,
    subject: 'Outreach test — your sender is working',
    html, textAlt: text,
    from: fromAddr,
    ...(replyToAddr ? { replyTo: replyToAddr } : {}),
    ...(sender.smtp ? { smtp: sender.smtp } : {}),
  });
  return { ok: true, to: dest, from: fromAddr, messageId: (info && info.messageId) || null };
}

// Send ONE enrollment's next due step, optionally through a specific pool
// identity `sender` (else the primary/legacy from + global SMTP). Returns
// 'sent' | 'skipped' | 'error'.
async function sendOne(enr, campaign, now = new Date(), sender = null) {
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

  // Global suppression re-check at send time — the last line of defense. An
  // address that unsubscribed / bounced / complained on ANY campaign must never
  // get another send, even if this enrollment predates the suppression.
  if (await isSuppressed(to)) {
    enr.status = 'stopped';
    enr.stopReason = 'suppressed';
    enr.nextSendAt = null;
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
  const spinSeed = `${enr.token}:${enr.stepIndex}`;
  // Threading: a follow-up (step > 0) reuses the first email's subject as
  // "Re: …" and references its Message-ID so it lands in the SAME conversation
  // — unless the step opts out with freshSubject.
  const threads = enr.stepIndex > 0 && !!enr.originMessageId && !step.freshSubject;
  let subject;
  if (threads) {
    subject = `Re: ${stripRePrefix(enr.originSubject)}`.replace(/[\r\n]+/g, ' ').trim();
  } else {
    // Merge FIRST, then resolve spintax — so a {{merge|fallback}} token is never
    // mistaken for a spin group. Collapse newlines so a weird companyName can't
    // smuggle extra SMTP headers via the subject.
    subject = applySpintax(renderTemplate(step.subject, ctx), `${spinSeed}:subj`).replace(/[\r\n]+/g, ' ').trim()
      || `Quick question for ${ctx.companyName || 'you'}`;
  }
  const bodyText = applySpintax(renderTemplate(step.body, ctx), `${spinSeed}:body`);
  const { html, text } = composeMessage({ bodyText, token: enr.token });

  const unsub = unsubscribeUrl(enr.token);
  // List-Unsubscribe: a mailto: (always) + the https one-click (when public
  // links are configured) — the fuller compliance signal Gmail/Yahoo reward.
  const mailtoAddr = unsubMailtoAddr();
  const luParts = [];
  if (mailtoAddr) luParts.push(`<mailto:${mailtoAddr}?subject=unsubscribe>`);
  if (unsub) luParts.push(`<${unsub}>`);
  const headers = luParts.length
    ? { 'List-Unsubscribe': luParts.join(', '), ...(unsub ? { 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {}) }
    : undefined;

  const messageId = outreachMessageId(enr, enr.stepIndex);
  // Sending identity: the chosen pool sender, else the primary/legacy from.
  const fromAddr = (sender && sender.from) || outreachFrom();
  const replyToAddr = (sender && sender.replyTo) || outreachReplyTo();
  try {
    const info = await sendEmail({
      to, subject, html, textAlt: text, headers, messageId,
      ...(threads ? { inReplyTo: enr.originMessageId, references: enr.originMessageId } : {}),
      from: fromAddr,
      ...(replyToAddr ? { replyTo: replyToAddr } : {}),
      ...(sender && sender.smtp ? { smtp: sender.smtp } : {}),
    });

    // Advance the enrollment.
    const sentMessageId = (info && info.messageId) || messageId;
    enr.sends.push({ stepIndex: enr.stepIndex, at: now, subject, messageId: sentMessageId, sender: (sender && sender.label) || '' });
    // Anchor the thread on the FIRST send so every follow-up can reply into it.
    if (!enr.originMessageId) { enr.originMessageId = sentMessageId; enr.originSubject = subject; }
    enr.toEmail = to;
    enr.sendAttempts = 0;
    enr.lastError = '';
    const nextIndex = enr.stepIndex + 1;
    const nextStep = (campaign.steps || [])[nextIndex];
    if (nextStep) {
      enr.stepIndex = nextIndex;
      const offset = Math.max(1, Number(nextStep.offsetDays) || 1);
      // Jitter off the exact wall-clock minute so touch N+1 never lands at the
      // same time as touch N (the window gate still holds it to business hours).
      enr.nextSendAt = jitteredFollowUpAt(now, offset, Math.random());
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
      // Suppress the ADDRESS globally (survives re-discovery under a new key)…
      await suppress(to, { reason: 'hard-bounce', source: 'smtp-bounce' });
      // …and flag the company so no OTHER campaign wastes a send on it either.
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
    // TRANSIENT error (greylist / timeout / rate limit): back off with a growing
    // delay (30m → 2h → 6h) instead of retrying every tick and hammering the MX.
    // Only give up after 5 attempts — one temporary hiccup must not permanently
    // fail a good lead.
    if (enr.sendAttempts >= 5) {
      enr.status = 'failed';
      enr.stopReason = 'smtp-error';
      enr.nextSendAt = null;
    } else {
      enr.nextSendAt = new Date(now.getTime() + transientBackoffMs(enr.sendAttempts));
    }
    await enr.save();
    console.error(`[outreach] send failed for ${enr.companyKey} (attempt ${enr.sendAttempts}):`, err.message);
    return 'error';
  }
}

// One engine tick: window → cap → due batch. Exported for tests + a manual
// "run now" trigger from the Studio.
// In-process overlap guard: the 15-min cron and a dashboard-triggered self-heal
// tick must never process the same due row at once (that could double-send).
let _ticking = false;

async function runOutreachTick(now = new Date(), opts = {}) {
  if (!smtpConfigured()) return { skipped: 'smtp-not-configured' };
  if (!outreachFrom())   return { skipped: 'sender-not-configured' };
  if (!isWithinSendWindow(now)) return { skipped: 'outside-window' };
  // Email-auth gate: hold if the sender domain is missing SPF/DMARC (cached DNS;
  // 'unknown'/transient never holds). Surfaced red in the Studio so it's fixable.
  if (authGateEnabled()) {
    const auth = await getAuthStatus(outreachFrom()).catch(() => null);
    if (auth && !auth.gateOk) {
      await recordRun(`held: sender email-auth (${auth.issues[0] || 'SPF/DMARC missing'})`);
      return { skipped: 'auth-hold', auth };
    }
  }
  // Circuit-breaker: auto-pause if the rolling 7-day bounce/complaint rate is too
  // high — sending into a bad list only digs the reputation hole deeper. Clears
  // itself as the bad window ages out.
  const breaker = await deliverabilityStats(now).catch(() => null);
  if (breaker && breaker.tripped) {
    await recordRun(`held: circuit-breaker — ${breaker.reason}`);
    return { skipped: 'circuit-breaker', deliverability: breaker };
  }
  if (_ticking) return { skipped: 'already-running' };
  _ticking = true;
  try {
    const campaigns = await OutreachCampaign.find({ status: 'active' }).lean();
    // Record even idle in-window ticks so `last_run_at` reflects a live engine
    // (and the dashboard's self-heal only fires when a tick is genuinely stale).
    if (!campaigns.length) { await recordRun('idle: no active campaigns'); return { skipped: 'no-active-campaigns' }; }
    const byId = new Map(campaigns.map((c) => [String(c._id), c]));
    const campaignIds = campaigns.map((c) => c._id);

    const state = await OutreachState.findOne({ key: 'engine' }).lean();
    const daysSince = state && state.firstSendAt
      ? Math.floor((now - new Date(state.firstSendAt)) / 86400000) : null;
    const days = daysSince == null ? 0 : daysSince;

    // Sender POOL: total daily capacity = sum of each inbox's (warm-up-ramped)
    // cap. Per-inbox remaining tracks that inbox's own daily count so we round-
    // robin without overshooting any one — the free way to send more per day.
    const senders = getSenders();
    const sentBySender = await sentTodayBySender(now);
    const legacyCount = sentBySender.get('') || 0; // pre-pool / untagged sends → the primary
    const remaining = new Map();
    let cap = 0;
    senders.forEach((s, i) => {
      const effCap = rampCap(days, s.dailyCap);
      cap += effCap;
      const used = (sentBySender.get(s.label) || 0) + (i === 0 ? legacyCount : 0);
      remaining.set(s.label, Math.max(0, effCap - used));
    });
    const sentToday = await getSentToday(now);
    const totalRemaining = [...remaining.values()].reduce((a, b) => a + b, 0);
    const batch = variableBatch(BATCH_PER_TICK, Math.random()); // vary the burst size
    const budget = Math.min(totalRemaining, batch);
    if (budget <= 0) { await recordRun(`held: daily cap reached (cap ${cap}, sentToday ${sentToday})`); return { skipped: 'daily-cap', cap, sentToday }; }

    // Round-robin the next sender that still has daily headroom.
    let rr = 0;
    const pickSender = () => {
      for (let k = 0; k < senders.length; k++) {
        const idx = (rr + k) % senders.length;
        const s = senders[idx];
        if ((remaining.get(s.label) || 0) > 0) { rr = (idx + 1) % senders.length; return s; }
      }
      return null;
    };

    // Per-domain daily counts (seeded once), incremented as we send this tick, so
    // no single domain gets more than DOMAIN_DAILY_CAP across the whole day.
    const domainCounts = await sentTodayByDomain(now);
    const pace = opts.pace === true; // cron paces sends; manual "run now" fires immediately

    let sent = 0, skipped = 0, errors = 0, domainDeferred = 0, attempts = 0;
    const maxAttempts = budget * 6; // bound the claim loop (some rows guard-skip/defer)
    while (sent < budget && attempts < maxAttempts) {
      attempts += 1;
      // ATOMIC claim: lease the oldest-due active row so no other worker (a
      // second instance, or a self-heal tick racing the cron) can grab the same
      // one and double-send. The lease pushes nextSendAt forward; whatever
      // sendOne does next sets a definitive nextSendAt (or a terminal status).
      const enr = await OutreachEnrollment.findOneAndUpdate(
        { status: 'active', campaignId: { $in: campaignIds }, nextSendAt: { $lte: now } },
        { $set: { nextSendAt: new Date(now.getTime() + LEASE_MS) } },
        { sort: { nextSendAt: 1 }, new: true },
      );
      if (!enr) break; // nothing left due
      const campaign = byId.get(String(enr.campaignId));
      if (!campaign) continue;

      // Per-domain cap: defer (don't consume budget) a row whose domain is maxed
      // out today. Push it past today's window; it stays active and resumes.
      const dom = domainOfEmail(enr.toEmail);
      if (dom && (domainCounts.get(dom) || 0) >= DOMAIN_DAILY_CAP) {
        enr.nextSendAt = new Date(now.getTime() + 12 * 60 * 60 * 1000);
        await enr.save();
        domainDeferred += 1;
        continue;
      }

      // Pick a sending inbox with headroom; if all are maxed, stop for now.
      const sender = pickSender();
      if (!sender) break;

      // Space real sends apart (cron only) to break the robotic burst.
      if (pace && sent > 0) await sleep(PACE_MIN_MS + Math.floor(Math.random() * (PACE_MAX_MS - PACE_MIN_MS)));

      const r = await sendOne(enr, campaign, now, sender);
      if (r === 'sent') {
        sent += 1;
        remaining.set(sender.label, (remaining.get(sender.label) || 1) - 1);
        if (dom) domainCounts.set(dom, (domainCounts.get(dom) || 0) + 1);
      } else if (r === 'skipped') skipped += 1;
      else errors += 1;
    }

    if (sent) await bumpSentToday(sent, now);
    const worked = sent || skipped || errors || domainDeferred;
    const result = worked
      ? `sent ${sent}, skipped ${skipped}, errors ${errors}${domainDeferred ? `, domain-deferred ${domainDeferred}` : ''} (cap ${cap}, sentToday ${sentToday + sent})`
      : `idle: nothing due (cap ${cap}, sentToday ${sentToday})`;
    if (sent || skipped || errors) console.log(`[outreach] tick: ${result}`);
    // Always record an in-window tick, so "last run" tracks the live engine.
    await recordRun(result);
    return { sent, skipped, errors, domainDeferred, cap, sentToday: sentToday + sent };
  } finally {
    _ticking = false;
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
function startOutreachEngine() {
  // Every 15 minutes; the tick itself gates on the ET business-hours window,
  // so UTC/DST drift can never move the send window.
  cron.schedule('*/15 * * * *', () => {
    // pace:true → space sends apart with jitter (the manual "run now" fires immediately).
    runOutreachTick(new Date(), { pace: true }).catch((e) => console.error('[outreach] tick error:', e.message));
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
  sendTestEmail,
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
  transientBackoffMs,
  jitteredFollowUpAt,
  variableBatch,
  outreachMessageId,
  isRoleEmail,
  deliverabilityStats,
  DAILY_CAP_MAX,
  DOMAIN_DAILY_CAP,
};
