// controllers/outreach.js
//
// HTTP layer for the cold-outreach engine: campaign CRUD, enrollment (with a
// dry-run preview), the funnel/overview the Studio's Outreach tab renders, and
// the two PUBLIC endpoints every outreach email links to (unsubscribe + open
// pixel, keyed by the enrollment's unguessable token).
//
// CRM integration: replies/unsubscribes write straight onto the Client record
// (tags, nextFollowUp, log, doNotEmail) via the same conventions the CRM
// controller uses, so warm leads surface in Today/Pipeline with no extra glue.

const OutreachCampaign = require('../models/OutreachCampaign');
const OutreachEnrollment = require('../models/OutreachEnrollment');
const OutreachState = require('../models/OutreachState');
const LeadFinderRun = require('../models/LeadFinderRun');
const Client = require('../models/Client');
const Order = require('../models/Order');
const { PLACED_STATUSES } = require('../models/Order');
const { warmFromEnrollment } = require('../services/warmHandoff');
const { suppress, isSuppressed, suppressedSet, removeBySource } = require('../services/suppression');
const { lintSteps } = require('../services/outreachContent');
const { verifyDomainsMx, emailDomain } = require('../services/emailVerify');

// The tag stamped on every company the moment it's enrolled in a campaign, so a
// reply (which also gets 'warm') is unmistakably traceable to the cold merge —
// and so the owner can filter "everyone I've cold-emailed" in the CRM at a glance.
const COLD_TAG = 'cold-email';

// Companies that are real CUSTOMERS by order reality (≥1 PLACED order) — the
// authoritative "these are my clients, never spam them" signal, independent of
// the stored stage. Returns the subset of `keys` that have a placed order.
async function keysWithPlacedOrders(keys) {
  if (!keys.length) return new Set();
  const rows = await Order.find({ companyKey: { $in: keys }, status: { $in: PLACED_STATUSES } })
    .select('companyKey').lean();
  return new Set(rows.map((r) => r.companyKey));
}
const { engineStatus, runOutreachTick, sendTestEmail, recheckAuth, newToken, pickEmail, sendBlockReason, deliverabilityStats, DAILY_CAP_MAX } = require('../services/outreachEngine');
const { runFinder, finderStatus } = require('../services/leadFinderRunner');
const { scoreLead } = require('../services/leadScore');
const { runFrontierSweep } = require('../services/leadFinderScheduler');
const { REGIONS, isRegion } = require('../services/dispensaryFinder');
const { isVertical, verticalPoolFilter, verticalOptions, DEFAULT_VERTICAL_ID } = require('../services/leadVerticals');

const NOT_ARCHIVED = { archived: { $ne: true } };

// Keep the auto-enrolled pipeline ~this many days of sending deep. The daily cap
// bounds real throughput, so enrolling far past this just balloons the "active"
// pool into a stale backlog and needlessly drains the cold-lead reserve. Target
// active size = daily cap × pipeline days; auto-enroll only tops up to it.
const PIPELINE_DAYS = parseInt(process.env.OUTREACH_PIPELINE_DAYS || '7', 10);
// Never enroll more than this in a single tick (politeness / MX-verify bound).
const ENROLL_TICK_MAX = parseInt(process.env.OUTREACH_ENROLL_TICK_MAX || '150', 10);
const pipelineTarget = () => Math.max(0, (Number(DAILY_CAP_MAX) || 50) * PIPELINE_DAYS);

// ── Pure funnel math (unit-tested) ────────────────────────────────────────────
// One campaign's funnel from its enrollment rows. "opened" and "replied" count
// companies (not events); a replied company also counts as opened when it has
// opens — the UI renders these as funnel stages.
function summarizeEnrollments(rows = []) {
  const s = {
    enrolled: 0, active: 0, sent: 0, opened: 0, replied: 0,
    completed: 0, unsubscribed: 0, stopped: 0, failed: 0, noEmail: 0, bounced: 0, suppressed: 0,
  };
  for (const e of rows) {
    if (!e) continue;
    s.enrolled += 1;
    if ((e.sends || []).length > 0) s.sent += 1;
    if ((e.openCount || 0) > 0 || e.lastOpenedAt) s.opened += 1;
    if (e.status && s[e.status] != null) s[e.status] += 1;
    // The silent killer: enrolled but no address to send to → stopped 'no-email'.
    // Counted separately so the UI can say exactly why nothing is going out.
    if (e.status === 'stopped' && e.stopReason === 'no-email') s.noEmail += 1;
    // Already opted out / bounced / complained somewhere before, so the engine
    // refused to send again — the spam-safety guard. Broken out so "72 enrolled,
    // 0 sent" reads as "held by suppression", not "broken".
    if (e.stopReason === 'suppressed') s.suppressed += 1;
    // Hard bounces / complaints / invalid addresses — the deliverability signal.
    if (['bounced', 'invalid-address', 'complaint'].includes(e.stopReason)) s.bounced += 1;
  }
  return s;
}

// Per-variant results for a campaign running a subject A/B test (unit-tested).
// The engine stamps 'A'/'B' on each send; an enrollment's arm is its first
// stamped send (arms are stable per token, so all its sends agree). Returns
// null when no send carries a variant, so the UI can hide the strip entirely
// for campaigns that aren't testing.
function summarizeAbTest(rows = []) {
  const mk = () => ({ sent: 0, opened: 0, replied: 0 });
  const out = { A: mk(), B: mk() };
  let any = false;
  for (const e of rows || []) {
    if (!e) continue;
    const first = (e.sends || []).find((x) => x && (x.variant === 'A' || x.variant === 'B'));
    if (!first) continue;
    any = true;
    const v = out[first.variant];
    v.sent += 1;
    if ((e.openCount || 0) > 0 || (e.sends || []).some((x) => x && x.openedAt)) v.opened += 1;
    if (e.status === 'replied') v.replied += 1;
  }
  return any ? out : null;
}

// Pure campaign-health read (unit-tested): turns funnel stats into one
// at-a-glance signal the UI badges, and — critically — explains WHY a campaign
// isn't sending instead of leaving the owner staring at zeros. Levels:
// 'ok' (green) | 'warn' (amber) | 'action' (red — needs a decision).
function campaignHealth(campaign = {}, stats = {}) {
  const st = { enrolled: 0, active: 0, sent: 0, replied: 0, completed: 0, noEmail: 0, bounced: 0, unsubscribed: 0, suppressed: 0, failed: 0, stopped: 0, ...stats };
  const status = campaign.status || 'draft';
  if (status === 'draft')  return { level: 'warn', label: 'Draft', hint: 'Launch it when the steps read right.' };
  if (status === 'paused') return { level: 'warn', label: 'Paused', hint: 'Sends are halted — resume to continue the drip.' };
  if (status === 'archived') return { level: 'warn', label: 'Archived', hint: 'This campaign is retired.' };
  if (st.enrolled === 0) return { level: 'warn', label: 'No leads yet', hint: 'Enroll companies to start the sequence.' };
  // Active but nothing is (or can be) sending — name the REAL dominant reason from
  // the stopped-reason breakdown, so the owner never stares at "0 sent, 0 active"
  // with a wrong or generic cause.
  if (st.active === 0 && st.sent === 0) {
    if (st.suppressed > 0 && st.suppressed >= st.noEmail && st.suppressed >= st.failed) {
      return { level: 'action', label: `${st.suppressed} held (suppressed)`,
        hint: `${st.suppressed} ${st.suppressed === 1 ? 'lead was' : 'leads were'} held because the address opted out / bounced before — OR a SENDER-side error (bad SMTP, unverified sender) wrongly suppressed them. If sends were failing, fix the sender and hit “Requeue dropped” to resume; real opt-outs stay blocked.` };
    }
    if (st.failed > 0 && st.failed >= st.noEmail) {
      return { level: 'action', label: `${st.failed} send${st.failed === 1 ? '' : 's'} failed`,
        hint: `${st.failed} ${st.failed === 1 ? 'lead' : 'leads'} couldn’t send. If your sender/SMTP was down or unverified, fix it and hit “Requeue dropped” — real bounces stay blocked.` };
    }
    if (st.noEmail > 0) {
      return { level: 'action', label: `${st.noEmail} missing email`,
        hint: `${st.noEmail} enrolled ${st.noEmail === 1 ? 'lead has' : 'leads have'} no usable email, so nothing can send. Enroll a fresh batch — the enroll list only offers leads with emails.` };
    }
    return { level: 'action', label: 'Nothing sending',
      hint: 'Every enrolled lead stopped before a send (opted out, became a customer, or an address issue). Enroll fresh leads to start the drip.' };
  }
  if (st.active === 0 && st.completed > 0) {
    return { level: 'warn', label: 'Sequence complete',
      hint: 'Everyone finished the sequence. Enroll fresh leads, or add a follow-up touch to keep it warm.' };
  }
  // Nothing active, some sent, none completed → the roster bounced/opted-out/failed
  // mid-sequence. Don't fall through to a false-green "Sending · 0 in sequence".
  if (st.active === 0) {
    return { level: 'warn', label: 'Roster exhausted',
      hint: `No one is still in sequence (${st.sent} sent, ${st.replied} replied). Enroll fresh leads to keep it going.` };
  }
  // Deliverability first — a bouncing/complained-about campaign is torching the
  // sender's reputation and must be paused before anything else matters.
  if (st.sent >= 20 && (st.bounced / st.sent) > 0.05) {
    return { level: 'action', label: `${Math.round((st.bounced / st.sent) * 100)}% bouncing`,
      hint: `${st.bounced} of ${st.sent} sent bounced or complained — pause and clean the list before you keep sending.` };
  }
  if (st.sent >= 20 && (st.unsubscribed / st.sent) > 0.02) {
    return { level: 'warn', label: 'High unsubscribe rate',
      hint: `${st.unsubscribed} of ${st.sent} unsubscribed — the list or the pitch may be off-target.` };
  }
  if (st.sent >= 15 && (st.replied / st.sent) < 0.02) {
    return { level: 'warn', label: 'Low reply rate',
      hint: `Only ${st.replied} of ${st.sent} sent have replied. Try a sharper subject line or opener.` };
  }
  return { level: 'ok', label: 'Sending',
    hint: `${st.active} in sequence · ${st.sent} sent · ${st.replied} replied.` };
}

// The one ranked to-do list the Dashboard leads with — synthesized from data
// getOverview already has, so the operator always knows the single most-important
// next move instead of scanning cards. Pure + unit-tested. Levels rank
// action > warm > info > ok; the first item is the "next best action" banner.
function buildNextActions({ engine = {}, campaigns = [], warmCount = 0, coldReserve = 0, autoEnrollOn = false } = {}) {
  const actions = [];
  const add = (level, text, cta = null) => actions.push({ level, text, cta });

  if (!engine.senderConfigured) {
    add('action', 'Set OUTREACH_EMAIL_FROM on the API to a dedicated cold-sending address — the engine is holding until then.');
  }
  if (engine.auth && engine.auth.level === 'red' && engine.authGate) {
    add('action', 'Sending is held: your sender domain isn’t authenticated. The exact DNS records to paste are in the panel below — add them, then hit re-check.');
  }
  if (engine.deliverability && engine.deliverability.tripped) {
    add('action', `Sending auto-paused — ${engine.deliverability.reason}. Clean the list, then it resumes on its own.`, { view: 'analytics' });
  }
  if (warmCount > 0) {
    add('warm', `${warmCount} warm lead${warmCount === 1 ? '' : 's'} replied or opening — follow up today.`, { view: 'replies' });
  }
  for (const c of campaigns) {
    if (c.health && c.health.level === 'action') add('action', `“${c.name}”: ${c.health.hint}`, { view: 'campaigns', campaignId: String(c._id) });
  }
  const anyActive = campaigns.some((c) => c.status === 'active');
  if (!anyActive && coldReserve > 0) {
    add('info', `${coldReserve} cold lead${coldReserve === 1 ? '' : 's'} in reserve and no active campaign — launch one to start sending.`, { view: 'campaigns' });
  } else if (anyActive && coldReserve >= 20 && !autoEnrollOn) {
    // Only nudge to hand-enroll when auto-enroll is OFF — with it on, the engine
    // tops the pipeline up on its own, so this would just be noise. Enrolling
    // happens in the Campaigns enroll dialog (the Lead engine is a progress
    // readout), so point the button where the action actually lives.
    add('info', `${coldReserve} cold leads waiting — enroll a fresh batch to keep the drip full.`, { view: 'campaigns' });
  } else if (anyActive && coldReserve === 0 && warmCount === 0) {
    add('info', 'Lead pool ran dry — the lead engine refills it automatically; check its progress.', { view: 'import' });
  }
  if (!actions.length) add('ok', 'All caught up — the engine is running and nothing needs you right now.');

  const rank = { action: 0, warm: 1, info: 2, ok: 3 };
  actions.sort((a, b) => rank[a.level] - rank[b.level]);
  return actions;
}

// Fire a catch-up tick when the dashboard is opened and the in-process cron may
// have missed a beat (host idled/restarted). Guarded so it only fires when the
// window is open, the sender is configured, and the last real run is stale —
// so it costs nothing on the happy path and never blocks the response.
function maybeSelfHealTick(engine) {
  try {
    if (!engine || !engine.withinWindow || !engine.smtpConfigured || !engine.senderConfigured) return;
    const last = engine.lastRunAt ? new Date(engine.lastRunAt).getTime() : 0;
    if (Date.now() - last < 20 * 60 * 1000) return; // fresh — the cron has it
    runOutreachTick().catch(() => {}); // fire-and-forget; the tick self-guards against overlap
  } catch { /* never let self-heal break the overview */ }
}

// ── Campaigns ─────────────────────────────────────────────────────────────────

// GET /api/outreach/overview — everything the tab's landing view needs in one
// shot: engine status, campaigns + funnels, the warm-lead list (opened/replied,
// hottest first), and recent send activity.
async function getOverview(req, res) {
  try {
    const [engine, campaigns, enrollments] = await Promise.all([
      engineStatus(),
      OutreachCampaign.find({ status: { $ne: 'archived' } }).sort({ createdAt: -1 }).lean(),
      OutreachEnrollment.find({}).lean(),
    ]);

    const byCampaign = new Map();
    for (const e of enrollments) {
      const k = String(e.campaignId);
      if (!byCampaign.has(k)) byCampaign.set(k, []);
      byCampaign.get(k).push(e);
    }
    // Opening the dashboard nudges a catch-up send if the cron may have idled.
    maybeSelfHealTick(engine);

    const campaignRows = campaigns.map((c) => {
      const rows = byCampaign.get(String(c._id)) || [];
      const stats = summarizeEnrollments(rows);
      return { ...c, stats, health: campaignHealth(c, stats), abTest: summarizeAbTest(rows) };
    });
    const campaignName = new Map(campaigns.map((c) => [String(c._id), c.name]));

    // Warm = engaged: replied first (hottest), then multi-opens, then single
    // opens; newest engagement first within each rung.
    const warm = enrollments
      .filter((e) => e.status === 'replied' || (e.openCount || 0) > 0)
      .sort((a, b) => {
        const rank = (e) => (e.status === 'replied' ? 2 : ((e.openCount || 0) > 1 ? 1 : 0));
        if (rank(b) !== rank(a)) return rank(b) - rank(a);
        const at = (e) => new Date(e.repliedAt || e.lastOpenedAt || 0).getTime();
        return at(b) - at(a);
      })
      .slice(0, 50)
      .map((e) => ({
        enrollmentId: e._id,
        companyKey: e.companyKey,
        companyName: e.companyName,
        campaignName: campaignName.get(String(e.campaignId)) || '',
        status: e.status,
        openCount: e.openCount || 0,
        lastOpenedAt: e.lastOpenedAt,
        repliedAt: e.repliedAt,
        sends: (e.sends || []).length,
      }));

    // Recent activity: the last sends across every campaign, newest first.
    const recent = enrollments
      .flatMap((e) => (e.sends || []).map((snd) => ({
        at: snd.at,
        subject: snd.subject,
        opened: !!snd.openedAt,
        companyKey: e.companyKey,
        companyName: e.companyName,
        campaignName: campaignName.get(String(e.campaignId)) || '',
      })))
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 25);

    // The single ranked to-do list the Dashboard leads with — cold-lead reserve
    // is the FRESH enrollable pool: never-personally-contacted leads that AREN'T
    // already enrolled in a campaign. Excluding the enrolled ones is what makes
    // the count drop after you enroll (and keeps the "cold leads waiting" nudge
    // from firing on leads that are already in the sequence).
    const st = await OutreachState.findOne({ key: 'engine' }).select('autoEnrollCampaignId').lean().catch(() => null);
    const autoEnrollOn = !!(st && st.autoEnrollCampaignId);
    const enrolledKeys = await OutreachEnrollment.distinct('companyKey').catch(() => []);
    const coldReserve = await Client.countDocuments({
      ...NOT_ARCHIVED, doNotEmail: { $ne: true }, stage: { $in: ['lead', 'contacted'] }, lastContact: null,
      ...(enrolledKeys.length ? { companyKey: { $nin: enrolledKeys } } : {}),
    }).catch(() => 0);
    const nextActions = buildNextActions({ engine, campaigns: campaignRows, warmCount: warm.length, coldReserve, autoEnrollOn });

    // Today's plan — the plain-English "here's what the engine is doing" readout,
    // so the owner trusts it without babysitting. Warm follow-ups DUE now (they
    // send first), new first-touches due, how many are mid-sequence, and the
    // reserve waiting to be enrolled. Capped by the day's send limit (engine.cap).
    const planNow = new Date();
    // Only ACTIVE campaigns send, so the plan counts must exclude a paused/draft
    // campaign's active enrollments (they aren't "due" / "in sequence" for sending).
    const activeCampaignIds = campaigns.filter((c) => c.status === 'active').map((c) => c._id);
    const inActive = { campaignId: { $in: activeCampaignIds } };
    const [followUpsDue, firstTouchesDue, inSequence] = await Promise.all([
      OutreachEnrollment.countDocuments({ status: 'active', ...inActive, stepIndex: { $gt: 0 }, nextSendAt: { $lte: planNow } }).catch(() => 0),
      OutreachEnrollment.countDocuments({ status: 'active', ...inActive, stepIndex: 0, nextSendAt: { $lte: planNow } }).catch(() => 0),
      OutreachEnrollment.countDocuments({ status: 'active', ...inActive }).catch(() => 0),
    ]);
    const plan = {
      followUpsDue, firstTouchesDue, dueNow: followUpsDue + firstTouchesDue,
      inSequence, reserve: coldReserve,
      dailyCap: (engine && (engine.cap != null ? engine.cap : engine.dailyCap)) || null,
      sentToday: (engine && engine.sentToday) || 0,
      pipelineTarget: pipelineTarget(),
    };

    res.json({ engine, campaigns: campaignRows, warm, recent, nextActions, coldReserve, plan,
      // The selectable business verticals (Dispensaries default, Breweries, …) so
      // the campaign editor can offer them without a separate round-trip.
      verticals: verticalOptions(),
      autoEnrollCampaignId: st && st.autoEnrollCampaignId ? String(st.autoEnrollCampaignId) : null });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// POST /api/outreach/campaigns — create (starts as 'draft'; the owner flips it
// to 'active' once the steps read right).
async function createCampaign(req, res) {
  try {
    const { name, description = '', steps = [], vertical } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'name required' });
    const campaign = await OutreachCampaign.create({
      name: String(name).trim(),
      description: String(description || ''),
      steps: sanitizeSteps(steps),
      // Which business type this campaign targets (the finder hunts it, enrollment
      // draws only its pool). Unknown/absent → dispensaries (the default).
      vertical: isVertical(vertical) ? vertical : DEFAULT_VERTICAL_ID,
    });
    res.json({ campaign, lint: lintSteps(campaign.steps) });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// Steps come from the editor UI — normalize shape + clamp offsets so a typo'd
// negative offset can't schedule a follow-up in the past.
function sanitizeSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .map((s, i) => ({
      offsetDays: i === 0 ? 0 : Math.max(1, Math.round(Number(s && s.offsetDays) || 1)),
      subject: String((s && s.subject) || ''),
      body: String((s && s.body) || ''),
      // Follow-ups thread by default; a step can opt out to a fresh subject line.
      freshSubject: !!(s && s.freshSubject),
      // Optional subject A/B arm (see StepSchema) — kept even where threading
      // will ignore it, so the owner's draft survives a step reorder.
      subjectB: String((s && s.subjectB) || ''),
    }))
    .filter((s) => s.subject.trim() || s.body.trim());
}

// PATCH /api/outreach/campaigns/:id — edit name/description/steps/status.
// Pausing ('paused') instantly halts its sends; enrollments keep their place.
async function updateCampaign(req, res) {
  try {
    const body = req.body || {};
    const set = {};
    if ('name' in body) set.name = String(body.name || '').trim();
    if ('description' in body) set.description = String(body.description || '');
    if ('steps' in body) set.steps = sanitizeSteps(body.steps);
    if ('vertical' in body && isVertical(body.vertical)) set.vertical = body.vertical;
    if ('status' in body) {
      if (!OutreachCampaign.CAMPAIGN_STATUSES.includes(body.status)) {
        return res.status(400).json({ message: `invalid status "${body.status}"` });
      }
      set.status = body.status;
    }
    const campaign = await OutreachCampaign.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    if (!campaign) return res.status(404).json({ message: 'campaign not found' });
    res.json({ campaign, lint: lintSteps(campaign.steps) });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/outreach/campaigns/:id/launch — the ONE-TAP "always-on". Does all
// three setup steps at once so the owner never wires it up by hand: flips the
// campaign to 'active', points continuous auto-enroll at it, fills the pipeline
// from the reserve now (capacity-matched), then fires touch 1 so the first
// emails go out within the window instead of waiting up to 15 min for the cron.
// Everything after — follow-ups, daily pacing, topping the pipeline up — the
// engine handles itself. Returns what filled + whether a batch fired.
async function launchCampaign(req, res) {
  try {
    const campaign = await OutreachCampaign.findByIdAndUpdate(
      req.params.id, { $set: { status: 'active' } }, { new: true },
    ).lean();
    if (!campaign) return res.status(404).json({ message: 'campaign not found' });
    // Turn on continuous auto-enroll for THIS campaign (only one at a time).
    await OutreachState.findOneAndUpdate(
      { key: 'engine' },
      { $set: { autoEnrollCampaignId: campaign._id } },
      { upsert: true },
    );
    // Fill the pipeline now so touch 1 has recipients, then kick a tick; report
    // both so the UI can show "enrolled N · sent M" or the exact reason it held.
    const filled = await autoFillCampaign(campaign).catch(() => null);
    const tick = await runOutreachTick().catch((e) => ({ error: e.message }));

    // If the cold-lead reserve is dry, kick the FREE lead-finder in the background
    // (don't await — an OSM/Overpass sweep is slow) so dispensaries flow in and the
    // 30-min auto-enroll cron feeds this campaign on its own. Non-blocking, and the
    // finder self-throttles + advances regions, so this can't run up any cost or
    // hammer anything. This is what makes Launch "work from nothing": press it with
    // an empty reserve and it goes and finds leads for you.
    // Reserve check is PER-VERTICAL: a brewery campaign needs brewery leads, so a
    // full dispensary reserve mustn't stop the brewery finder from kicking. And
    // the kick targets THIS campaign's vertical, so Launch on a brand-new vertical
    // goes and finds that kind of lead from nothing.
    const reserve = await Client.countDocuments({
      ...NOT_ARCHIVED, doNotEmail: { $ne: true }, stage: { $in: ['lead', 'contacted'] }, lastContact: null,
      ...verticalPoolFilter(campaign.vertical),
    }).catch(() => null);
    // Kick the finder when the reserve is dry OR when the fill enrolled NOBODY — a
    // reserve that's all no-email/suppressed/customer counts >0 but yields 0
    // enrollments, so "Launch from nothing" would otherwise silently send nothing
    // and never self-heal. Either way, go find fresh leads for this vertical.
    const filledCount = (filled && filled.enrolled) || 0;
    const finderKicked = reserve === 0 || filledCount === 0;
    if (finderKicked) {
      runFrontierSweep({ force: true, vertical: campaign.vertical })
        .catch((e) => console.error('[outreach] launch finder kick:', e.message));
    }
    res.json({ campaign, filled, tick, finderKicked, autoEnrollCampaignId: String(campaign._id) });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// GET /api/outreach/campaigns/:id — one campaign + its per-company enrollment
// rows (the campaign detail table).
async function getCampaign(req, res) {
  try {
    const campaign = await OutreachCampaign.findById(req.params.id).lean();
    if (!campaign) return res.status(404).json({ message: 'campaign not found' });
    const enrollments = await OutreachEnrollment.find({ campaignId: campaign._id })
      .sort({ updatedAt: -1 }).lean();
    res.json({ campaign, stats: summarizeEnrollments(enrollments), enrollments, lint: lintSteps(campaign.steps), stepFunnel: buildStepFunnel(enrollments) });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// ── Enrollment ────────────────────────────────────────────────────────────────

// Eligibility for cold outreach, given a live Client + whether it's already
// enrolled + whether it's a customer by order reality. Returns '' when eligible,
// else the skip reason. The order-reality check is what keeps a client who's
// still stored at an early stage (e.g. a repeat buyer never bumped to 'customer')
// out of the cold list — the owner's #1 ask: "don't spam my clients."
function enrollBlockReason(client, alreadyEnrolled, isCustomerByOrder, isSuppressedEmail = false) {
  if (!client) return 'not-found';
  if (alreadyEnrolled) return 'already-enrolled';
  if (isCustomerByOrder) return 'is-customer';
  // Cold means cold — enforced at the WRITE path too, not just the pick-list
  // query, so a stale dialog, a raw API call, or any future caller can never
  // enroll someone the owner has personally touched (his real clients whose
  // orders predate the Orders system live behind exactly this flag).
  if (client.lastContact) return 'already-contacted';
  const live = sendBlockReason(client); // archived / do-not-email / closed / customer-stage
  if (live) return live;
  if (!pickEmail(client)) return 'no-email';
  // Address is on the global do-not-contact list (unsubscribed / bounced /
  // complained somewhere before) — never cold-email it again.
  if (isSuppressedEmail) return 'suppressed';
  return '';
}

// GET /api/outreach/candidates?campaignId=&q=&stage=&leadSource=
// The enroll dialog's pick-list: genuinely COLD companies only, no overrides.
// Beyond the hard gates (has email, not opted out, not a customer, not already
// enrolled), we EXCLUDE anyone the owner has personally touched — the
// authoritative signal is `lastContact`, which is set whenever a call/text/
// visit/note is logged (or an import carries a contact date). A company you've
// already called or visited must never get a stranger's cold intro. There used
// to be an ?includeContacted override; it was removed on purpose — it let real
// clients (whose orders predate the Orders system, so the order-reality check
// can't see them) surface in the cold list. Re-warming someone you know is a
// personal email from you, not a campaign.
async function getCandidates(req, res) {
  try {
    const { campaignId = '', q = '', stage = '', leadSource = '' } = req.query || {};
    const find = { ...NOT_ARCHIVED, doNotEmail: { $ne: true } };
    find.stage = stage ? stage : { $in: ['lead', 'contacted'] };
    find.lastContact = null; // cold = never personally contacted, always
    if (leadSource) find.leadSource = leadSource;
    // Scope the enroll list to the campaign's vertical pool, so a brewery
    // campaign only ever offers brewery leads (dispensary = the catch-all pool, so
    // its enroll list is unchanged). No campaign → the full cold pool.
    if (campaignId) {
      const camp = await OutreachCampaign.findById(campaignId).select('vertical').lean().catch(() => null);
      Object.assign(find, verticalPoolFilter(camp ? camp.vertical : DEFAULT_VERTICAL_ID));
    }
    if (q) {
      const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      find.$or = [{ companyName: rx }, { clientName: rx }, { email: rx }, { address: rx }, { area: rx }];
    }
    const clients = await Client.find(find)
      .select('companyKey companyName clientName email phone address area stage leadSource tags contacts lastContact')
      .sort({ companyName: 1 }).limit(500).lean();

    const enrolledKeys = campaignId
      ? new Set((await OutreachEnrollment.find({ campaignId }).select('companyKey').lean()).map((e) => e.companyKey))
      : new Set();
    // Never offer a real customer (by order reality) as a cold-outreach candidate,
    // even if their stored stage is still 'lead'/'contacted' — client protection.
    const customerKeys = await keysWithPlacedOrders(clients.map((c) => c.companyKey));
    // Every email address we've EVER queued/sent to — so the same inbox is never
    // shown as a fresh lead (a shop listed twice, or a shared chain inbox).
    const usedEmails = new Set(
      (await OutreachEnrollment.find({}).select('toEmail').lean())
        .map((e) => String(e.toEmail || '').toLowerCase()).filter(Boolean),
    );
    // Globally suppressed addresses (unsubscribed / bounced / complained) — never
    // offer one as a fresh candidate.
    const suppressed = await suppressedSet(clients.map((c) => pickEmail(c)));

    const rows = [];
    const seenEmail = new Set();
    for (const c of clients) {
      const outreachEmail = pickEmail(c);
      if (!outreachEmail || enrolledKeys.has(c.companyKey) || customerKeys.has(c.companyKey)) continue;
      const e = outreachEmail.toLowerCase();
      if (usedEmails.has(e) || seenEmail.has(e) || suppressed.has(e)) continue; // de-dupe + suppression
      seenEmail.add(e);
      // Attach the lead-quality score so the pick-list can lead with the
      // best/most-reachable leads instead of alphabetically — the whole point of
      // scoring, which previously only badged the CRM list.
      const sc = scoreLead(c);
      rows.push({ ...c, outreachEmail, leadScore: sc.score, leadGrade: sc.grade, leadReasons: sc.reasons });
    }
    rows.sort((a, b) => (b.leadScore - a.leadScore)
      || String(a.companyName || '').localeCompare(String(b.companyName || '')));
    res.json({ candidates: rows });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/outreach/campaigns/:id/enroll { companyKeys: [], dryRun? }
// Enroll companies; every skip is reported with its reason so the dialog can
// show exactly what will (and won't) go out. Dry-run = same math, no writes.
async function enrollCompanies(req, res) {
  try {
    const campaign = await OutreachCampaign.findById(req.params.id).lean();
    if (!campaign) return res.status(404).json({ message: 'campaign not found' });
    const body = req.body || {};
    const dryRun = body.dryRun === true || body.dryRun === 'true';
    const keys = [...new Set((Array.isArray(body.companyKeys) ? body.companyKeys : [])
      .map((k) => String(k || '').trim()).filter(Boolean))];
    if (!keys.length) return res.status(400).json({ message: 'companyKeys required' });

    const [clients, existing, customerKeys, allEnrollments] = await Promise.all([
      // Scope to the campaign's vertical, same as the auto-enroll path — so a raw
      // API call or a dialog left open after the campaign's vertical changed can't
      // enroll a brewery lead into a dispensary campaign (wrong-vertical pitch).
      // Out-of-vertical keys simply aren't returned → reported skipped 'not-found'.
      Client.find({ companyKey: { $in: keys }, ...verticalPoolFilter(campaign.vertical) }).lean(),
      OutreachEnrollment.find({ campaignId: campaign._id, companyKey: { $in: keys } })
        .select('companyKey').lean(),
      keysWithPlacedOrders(keys),
      OutreachEnrollment.find({}).select('toEmail').lean(),
    ]);
    const clientByKey = new Map(clients.map((c) => [c.companyKey, c]));
    const enrolledSet = new Set(existing.map((e) => e.companyKey));
    // Every inbox already queued anywhere — plus the emails we accept in THIS
    // batch — so the same address is never cold-emailed twice.
    const usedEmails = new Set(allEnrollments.map((e) => String(e.toEmail || '').toLowerCase()).filter(Boolean));
    // Globally suppressed addresses (unsubscribed / bounced / complained) — one
    // query for the whole batch; a suppressed lead can never re-enter the machine.
    const suppressed = await suppressedSet(clients.map((c) => pickEmail(c)));

    const eligible = [];
    const skipped = [];
    for (const key of keys) {
      const client = clientByKey.get(key) || null;
      const suppressedEmail = client ? suppressed.has(String(pickEmail(client) || '').toLowerCase()) : false;
      const reason = enrollBlockReason(client, enrolledSet.has(key), customerKeys.has(key), suppressedEmail);
      if (reason) { skipped.push({ companyKey: key, reason }); continue; }
      const email = String(pickEmail(client) || '').toLowerCase();
      // Belt-and-suspenders: gate enroll-eligibility on the SAME pickEmail() the
      // sender uses, so a lead can never pass enroll but then stop 'no-email' on
      // its first tick (leaving the owner with "N enrolled, 0 sent, no reason").
      if (!email) { skipped.push({ companyKey: key, reason: 'no-email' }); continue; }
      if (usedEmails.has(email)) { skipped.push({ companyKey: key, reason: 'duplicate-email' }); continue; }
      usedEmails.add(email);
      eligible.push(client);
    }

    // List-hygiene: verify each eligible address's DOMAIN actually accepts mail
    // (MX / A-record) before we burn a send + daily cap on it. Deduped per
    // domain, so a batch is a few DNS lookups, not one per lead. Definitively
    // dead domains are dropped as 'dead-domain'; the company stays in the CRM.
    if (eligible.length) {
      const domains = eligible.map((c) => emailDomain(String(pickEmail(c) || '').toLowerCase()));
      const mxMap = await verifyDomainsMx(domains).catch(() => new Map());
      const kept = [];
      for (const c of eligible) {
        const dom = emailDomain(String(pickEmail(c) || '').toLowerCase());
        if (dom && mxMap.get(dom) === false) { skipped.push({ companyKey: c.companyKey, reason: 'dead-domain' }); continue; }
        kept.push(c);
      }
      eligible.length = 0;
      eligible.push(...kept);
    }

    if (!dryRun && eligible.length) {
      const now = new Date();
      try {
        await OutreachEnrollment.insertMany(eligible.map((c) => ({
          campaignId: campaign._id,
          companyKey: c.companyKey,
          companyName: c.companyName || c.clientName || '',
          toEmail: pickEmail(c),
          status: 'active',
          stepIndex: 0,
          // Stagger the first-touch due time (0–90 min) so a batch of enrolls
          // doesn't create a clump of identical nextSendAt timestamps — the
          // daily cap still paces the actual sends.
          nextSendAt: new Date(now.getTime() + Math.floor(Math.random() * 90 * 60 * 1000)),
          token: newToken(),
        })), { ordered: false });
      } catch (err) {
        // A concurrent enroll can race the unique (campaignId, companyKey)
        // index — duplicate-key write errors just mean "already in", every
        // other row still inserted (ordered:false). Anything else is real.
        if (err.code !== 11000 && !(err.writeErrors || []).every((w) => w.code === 11000)) throw err;
      }
      // Stamp the traceability tag on every enrolled company (idempotent).
      await Client.updateMany(
        { companyKey: { $in: eligible.map((c) => c.companyKey) } },
        { $addToSet: { tags: COLD_TAG } },
      );
    }

    res.json({
      dryRun,
      enrolled: eligible.length,
      skipped,
      total: keys.length,
    });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// GET /api/outreach/queue — what the engine will send next (due + upcoming),
// oldest-due first, with enough context to read as a checklist.
async function getQueue(req, res) {
  try {
    // Only ACTIVE campaigns actually send, so the queue must not show a paused /
    // draft campaign's rows as "due now" (the engine skips them) — that inflated
    // "due now" and misled the owner about what's going out.
    const campaigns = await OutreachCampaign.find({ status: 'active' }).lean();
    const byId = new Map(campaigns.map((c) => [String(c._id), c]));
    const rows = await OutreachEnrollment.find({ status: 'active', campaignId: { $in: campaigns.map((c) => c._id) } })
      .sort({ nextSendAt: 1 }).limit(100).lean();
    const queue = rows.map((e) => {
      const c = byId.get(String(e.campaignId));
      const step = c ? (c.steps || [])[e.stepIndex] : null;
      return {
        enrollmentId: e._id,
        companyKey: e.companyKey,
        companyName: e.companyName,
        toEmail: e.toEmail,
        campaignName: c ? c.name : '',
        campaignStatus: c ? c.status : '',
        stepIndex: e.stepIndex,
        stepCount: c ? (c.steps || []).length : 0,
        stepSubject: step ? step.subject : '',
        nextSendAt: e.nextSendAt,
        sends: (e.sends || []).length,
      };
    });
    res.json({ queue });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/outreach/enrollments/:id/replied — the "they answered!" button.
// Stops the sequence and flips the company hot in the CRM (warm tag, follow up
// TODAY, touch logged, stage → contacted) via the SHARED warm handoff — the
// exact same transition the automatic reply ingest runs, so the button and the
// triage inbox can never drift apart.
async function markReplied(req, res) {
  try {
    const enr = await OutreachEnrollment.findById(req.params.id);
    if (!enr) return res.status(404).json({ message: 'enrollment not found' });
    await warmFromEnrollment(enr, { source: 'button' });
    res.json({ ok: true, enrollment: enr.toObject() });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/outreach/enrollments/:id/stop — owner halts one company's sequence.
async function stopEnrollment(req, res) {
  try {
    const enr = await OutreachEnrollment.findById(req.params.id);
    if (!enr) return res.status(404).json({ message: 'enrollment not found' });
    if (enr.status === 'active') {
      enr.status = 'stopped';
      enr.stopReason = 'owner';
      enr.nextSendAt = null;
      await enr.save();
    }
    res.json({ ok: true, enrollment: enr.toObject() });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/outreach/campaigns/:id/unenroll-all — clear the whole roster off a
// campaign so it can be re-enrolled fresh (e.g. after enrolling leads that turned
// out to have no email). Deletes the enrollment rows; the companies stay in the
// CRM. By default it protects anyone already sent to (won't wipe real send
// history / re-cold-email them); pass { includeSent: true } to remove everyone.
async function unenrollAll(req, res) {
  try {
    const campaign = await OutreachCampaign.findById(req.params.id).lean();
    if (!campaign) return res.status(404).json({ message: 'campaign not found' });
    const includeSent = (req.body || {}).includeSent === true || (req.body || {}).includeSent === 'true';
    const filter = { campaignId: campaign._id };
    if (!includeSent) filter['sends.0'] = { $exists: false }; // only never-sent rows
    const result = await OutreachEnrollment.deleteMany(filter);
    res.json({ ok: true, removed: result.deletedCount || 0, keptSent: !includeSent });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/outreach/campaigns/:id/reset — FULL fresh start. Deletes EVERY
// enrollment for this campaign (including already-sent), so the campaign re-runs
// cleanly from email 1 the next time auto-enroll refills it. Deliberately narrow
// about what it does NOT touch:
//   • Companies stay in the CRM (only the enrollment rows are removed).
//   • The Suppression list (unsubscribes / bounces) is a SEPARATE collection and
//     is never touched — anyone who opted out stays permanently protected.
//   • The sender's warm-up ramp (OutreachState.firstSendAt) and today's daily
//     cap (sentToday) are preserved on purpose: resetting them would re-throttle
//     a warmed sender or let it over-send today.
// Requires an explicit { confirm: true } so a stray request can't wipe the roster.
async function resetCampaign(req, res) {
  try {
    const campaign = await OutreachCampaign.findById(req.params.id).lean();
    if (!campaign) return res.status(404).json({ message: 'campaign not found' });
    const confirm = (req.body || {}).confirm;
    if (confirm !== true && confirm !== 'true') {
      return res.status(400).json({ message: 'Pass { confirm: true } — reset clears the whole roster.' });
    }
    const result = await OutreachEnrollment.deleteMany({ campaignId: campaign._id });
    return res.json({ ok: true, removed: result.deletedCount || 0 });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// DELETE /api/outreach/campaigns/:id — remove a campaign entirely (a stale draft
// or a mis-set-up one). Also deletes its enrollments and, if it was the
// auto-enroll target, clears that pointer so the engine doesn't chase a deleted
// campaign. Opt-outs (Suppression) and CRM contacts are untouched. Confirm-gated.
async function deleteCampaign(req, res) {
  try {
    const campaign = await OutreachCampaign.findById(req.params.id).lean();
    if (!campaign) return res.status(404).json({ message: 'campaign not found' });
    const confirm = (req.body || {}).confirm;
    if (confirm !== true && confirm !== 'true') {
      return res.status(400).json({ message: 'Pass { confirm: true } — this permanently deletes the campaign.' });
    }
    const removed = await OutreachEnrollment.deleteMany({ campaignId: campaign._id });
    // If this campaign was the auto-enroll target, stop pointing the engine at it.
    await OutreachState.updateOne(
      { key: 'engine', autoEnrollCampaignId: campaign._id },
      { $set: { autoEnrollCampaignId: null } },
    );
    await OutreachCampaign.deleteOne({ _id: campaign._id });
    return res.json({ ok: true, deleted: String(campaign._id), removedEnrollments: removed.deletedCount || 0 });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// ── Auto-enroll (Wave 7) ──────────────────────────────────────────────────────

// Discover cold candidates and enroll up to `limit` of them into `campaign`,
// best-lead-first — the same cold-only + suppression + hygiene guards the manual
// enroll uses, so the auto path can never do anything the owner couldn't. Used by
// the auto-enroll cron and the "fill now" toggle. Returns { enrolled }.
async function autoFillCampaign(campaign, { limit } = {}) {
  // Capacity-matched: with no explicit limit (the auto-enroll cron), only enroll
  // enough to top the ACTIVE pool up to ~a week of sending — never balloon it.
  // An explicit limit (a manual burst) bypasses the cap.
  if (limit == null) {
    const activeCount = await OutreachEnrollment.countDocuments({ campaignId: campaign._id, status: 'active' });
    const room = pipelineTarget() - activeCount;
    if (room <= 0) return { enrolled: 0, skipped: 'pipeline-full', activeCount };
    limit = Math.min(room, ENROLL_TICK_MAX);
  }
  // Cold = never personally contacted, has an email, not opted out — and in THIS
  // campaign's vertical pool (a brewery campaign never enrolls a dispensary lead;
  // dispensary is the catch-all, so its pool is unchanged).
  const clients = await Client.find({ ...NOT_ARCHIVED, doNotEmail: { $ne: true },
    stage: { $in: ['lead', 'contacted'] }, lastContact: null, ...verticalPoolFilter(campaign.vertical) })
    .select('companyKey companyName clientName email phone address area stage leadSource contacts lastContact')
    .limit(1500).lean();
  if (!clients.length) return { enrolled: 0 };

  const keys = clients.map((c) => c.companyKey);
  const [existing, customerKeys, allEnrollments] = await Promise.all([
    OutreachEnrollment.find({ campaignId: campaign._id, companyKey: { $in: keys } }).select('companyKey').lean(),
    keysWithPlacedOrders(keys),
    OutreachEnrollment.find({}).select('toEmail').lean(),
  ]);
  const enrolledSet = new Set(existing.map((e) => e.companyKey));
  const usedEmails = new Set(allEnrollments.map((e) => String(e.toEmail || '').toLowerCase()).filter(Boolean));
  const suppressed = await suppressedSet(clients.map((c) => pickEmail(c)));

  // Best-scored leads first, take up to `limit` eligible.
  const scored = clients.map((c) => ({ c, sc: scoreLead(c).score })).sort((a, b) => b.sc - a.sc);
  const eligible = [];
  for (const { c } of scored) {
    if (eligible.length >= limit) break;
    const email = String(pickEmail(c) || '').toLowerCase();
    const reason = enrollBlockReason(c, enrolledSet.has(c.companyKey), customerKeys.has(c.companyKey), email ? suppressed.has(email) : false);
    if (reason || !email || usedEmails.has(email)) continue;
    usedEmails.add(email);
    eligible.push(c);
  }
  if (!eligible.length) return { enrolled: 0 };

  // List hygiene: drop dead-MX domains before enrolling.
  const mxMap = await verifyDomainsMx(eligible.map((c) => emailDomain(String(pickEmail(c) || '').toLowerCase()))).catch(() => new Map());
  const kept = eligible.filter((c) => {
    const d = emailDomain(String(pickEmail(c) || '').toLowerCase());
    return !(d && mxMap.get(d) === false);
  });
  if (!kept.length) return { enrolled: 0 };

  const now = new Date();
  try {
    await OutreachEnrollment.insertMany(kept.map((c) => ({
      campaignId: campaign._id,
      companyKey: c.companyKey,
      companyName: c.companyName || c.clientName || '',
      toEmail: pickEmail(c),
      status: 'active',
      stepIndex: 0,
      nextSendAt: new Date(now.getTime() + Math.floor(Math.random() * 90 * 60 * 1000)),
      token: newToken(),
    })), { ordered: false });
  } catch (err) {
    if (err.code !== 11000 && !(err.writeErrors || []).every((w) => w.code === 11000)) throw err;
  }
  await Client.updateMany({ companyKey: { $in: kept.map((c) => c.companyKey) } }, { $addToSet: { tags: COLD_TAG } });
  return { enrolled: kept.length };
}

// Cron: top up the auto-enroll target from the reserve every 30 min (idle when
// off). Started from server.js.
function startAutoEnroll() {
  const cron = require('node-cron');
  cron.schedule('*/30 * * * *', () => {
    runAutoEnrollTick()
      .then((r) => { if (r && r.enrolled) console.log(`[outreach] auto-enroll: +${r.enrolled}`); })
      .catch((e) => console.warn('[outreach] auto-enroll failed:', e.message));
  });
  console.log('[outreach] auto-enroll cron started — tops the active campaign from the reserve when enabled');
}

// One auto-enroll cron pass: if a target campaign is set + still active, top it
// up from the reserve. Bounded; safe to call often (dedupe via the unique index).
async function runAutoEnrollTick() {
  const state = await OutreachState.findOne({ key: 'engine' }).lean().catch(() => null);
  const id = state && state.autoEnrollCampaignId;
  if (!id) return { skipped: 'off' };
  const campaign = await OutreachCampaign.findById(id).lean();
  if (!campaign || campaign.status !== 'active') return { skipped: 'campaign-inactive' };
  return autoFillCampaign(campaign); // capacity-matched (tops the pipeline to ~a week deep)
}

// POST /api/outreach/campaigns/:id/auto-enroll { enabled } — turn auto-enroll on
// for THIS campaign (only one at a time) or off. Enabling runs one fill now.
async function setAutoEnroll(req, res) {
  try {
    const campaign = await OutreachCampaign.findById(req.params.id).lean();
    if (!campaign) return res.status(404).json({ message: 'campaign not found' });
    const enabled = (req.body || {}).enabled === true || (req.body || {}).enabled === 'true';
    await OutreachState.findOneAndUpdate(
      { key: 'engine' },
      { $set: { autoEnrollCampaignId: enabled ? campaign._id : null } },
      { upsert: true },
    );
    let filled = null;
    if (enabled && campaign.status === 'active') filled = await autoFillCampaign(campaign).catch(() => null);
    res.json({ ok: true, autoEnrollCampaignId: enabled ? String(campaign._id) : null, filled });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/outreach/run-tick — owner-triggered "send the next batch now".
// Same code path as the cron (window, caps, guards all apply).
async function runTickNow(req, res) {
  try {
    const result = await runOutreachTick();
    res.json(result);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// POST /api/outreach/test-send — the first-run wizard's "send a test to yourself"
// button. Delivers one sample through the real sender identity + SMTP so the
// operator can eyeball inbox-vs-spam placement before enrolling anyone. Config /
// validation problems come back as a 400 with a plain-English message (the
// wizard shows it verbatim); an SMTP failure is a 502 so it reads as "the send
// itself broke", not "you asked for something invalid".
async function sendTest(req, res) {
  const to = (req.body && req.body.to) || '';
  try {
    const result = await sendTestEmail(to);
    res.json(result);
  } catch (e) {
    const msg = String(e.message || e);
    // Pre-flight problems (unset sender/SMTP, bad address) → 400; anything the
    // transport threw → 502 so the UI can distinguish "fix your input" from
    // "the mail server rejected it".
    const preflight = /OUTREACH_EMAIL_FROM|SMTP isn|valid email/i.test(msg);
    res.status(preflight ? 400 : 502).json({ message: msg });
  }
}

// POST /api/outreach/auth-recheck — bypass the 1h DNS cache and re-classify the
// sender domain right now. The owner just pasted a record and wants the chips
// to go green without waiting out the cache.
async function recheckAuthNow(req, res) {
  try {
    const auth = await recheckAuth();
    if (!auth) return res.status(400).json({ message: 'Set OUTREACH_EMAIL_FROM first — there is no sender domain to check yet.' });
    res.json({ auth });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── Analytics ─────────────────────────────────────────────────────────────────

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS',
  'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY',
  'NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
  'WI','WY','DC',
]);

// Best-effort 2-letter US state from a stored address ("… City NJ 07102" or
// "… City, NJ"). '' when it can't tell. Pure + unit-tested.
function parseState(address) {
  const s = String(address || '').trim();
  let m = s.match(/\b([A-Za-z]{2})\s+\d{5}(?:-\d{4})?\s*$/); // "NJ 07102"
  if (m && US_STATES.has(m[1].toUpperCase())) return m[1].toUpperCase();
  m = s.match(/,\s*([A-Za-z]{2})\.?\s*$/); // trailing ", NJ"
  if (m && US_STATES.has(m[1].toUpperCase())) return m[1].toUpperCase();
  return '';
}

// Per-state outreach funnel from enrollments + a companyKey→state map. Pure.
function buildStateFunnels(enrollments = [], stateByKey = new Map()) {
  const by = new Map();
  for (const e of enrollments) {
    if (!e) continue;
    const st = stateByKey.get(e.companyKey) || 'Unknown';
    if (!by.has(st)) by.set(st, { state: st, leads: 0, sent: 0, opened: 0, replied: 0, unsubscribed: 0 });
    const row = by.get(st);
    row.leads += 1;
    if ((e.sends || []).length > 0) row.sent += 1;
    if ((e.openCount || 0) > 0 || e.lastOpenedAt) row.opened += 1;
    if (e.status === 'replied') row.replied += 1;
    if (e.status === 'unsubscribed') row.unsubscribed += 1;
  }
  // Real states first (by leads desc), Unknown last.
  return [...by.values()].sort((a, b) => {
    if (a.state === 'Unknown') return 1;
    if (b.state === 'Unknown') return -1;
    return b.leads - a.leads;
  });
}

// Monday-anchored UTC week key (ms) for an instant. Pure.
function weekStartMs(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - day * 86400000;
}

// Weekly send/open/reply trend for the last `weeks` weeks. Pure (nowMs injected).
function weeklyTrend(enrollments = [], nowMs = Date.now(), weeks = 8) {
  const thisWeek = weekStartMs(nowMs);
  const buckets = [];
  const idx = new Map();
  for (let i = weeks - 1; i >= 0; i--) {
    const wk = thisWeek - i * 7 * 86400000;
    const b = { weekStart: wk, sent: 0, opened: 0, replied: 0, unsubscribed: 0 };
    idx.set(wk, b); buckets.push(b);
  }
  const bump = (ms, field) => {
    const b = idx.get(weekStartMs(ms));
    if (b) b[field] += 1;
  };
  for (const e of enrollments) {
    for (const s of (e.sends || [])) {
      if (s && s.at) bump(new Date(s.at).getTime(), 'sent');
      if (s && s.openedAt) bump(new Date(s.openedAt).getTime(), 'opened');
    }
    if (e.repliedAt) bump(new Date(e.repliedAt).getTime(), 'replied');
    if (e.unsubscribedAt) bump(new Date(e.unsubscribedAt).getTime(), 'unsubscribed'); // deliverability decay
  }
  return buckets;
}

// Per-touch drop-off funnel — which STEP of the sequence is dead. For each step
// index (inferred from the sends themselves, so it works overall or per-campaign):
// how many were sent that touch, opened it, and — attributed to the LAST touch a
// lead received — replied or unsubscribed after it. Pure + unit-tested.
function buildStepFunnel(enrollments = []) {
  const rows = [];
  const ensure = (i) => { while (rows.length <= i) rows.push({ step: rows.length, sent: 0, opened: 0, replied: 0, unsubscribed: 0 }); return rows[i]; };
  for (const e of enrollments) {
    if (!e) continue;
    const sends = e.sends || [];
    const stepsSent = new Set();
    for (const s of sends) {
      const si = (s && s.stepIndex) || 0;
      stepsSent.add(si);
      if (s && s.openedAt) ensure(si).opened += 1;
    }
    for (const si of stepsSent) ensure(si).sent += 1;
    const lastStep = sends.length ? Math.max(...sends.map((s) => (s && s.stepIndex) || 0)) : -1;
    if (lastStep >= 0) {
      const r = ensure(lastStep);
      if (e.status === 'replied') r.replied += 1;
      if (e.status === 'unsubscribed') r.unsubscribed += 1;
    }
  }
  return rows;
}

// GET /api/outreach/analytics — overall funnel, per-state funnel, weekly trend,
// and finder coverage per state. Powers the Studio's Analytics view.
async function getAnalytics(req, res) {
  try {
    const [enrollments, finderRuns] = await Promise.all([
      OutreachEnrollment.find({}).lean(),
      LeadFinderRun.find({ dryRun: false }).sort({ createdAt: -1 }).limit(300).lean(),
    ]);

    const keys = [...new Set(enrollments.map((e) => e.companyKey))];
    const clients = keys.length
      ? await Client.find({ companyKey: { $in: keys } }).select('companyKey address area').lean()
      : [];
    const stateByKey = new Map(clients.map((c) => [c.companyKey, parseState(c.address || c.area)]));

    // Finder coverage per region: latest snapshot + cumulative imported.
    const coverage = new Map();
    for (const r of finderRuns) {
      if (!coverage.has(r.region)) {
        coverage.set(r.region, {
          region: r.region, found: r.found, withEmail: r.withEmail, verified: r.verified || 0,
          created: 0, lastSweptAt: r.createdAt,
        });
      }
      coverage.get(r.region).created += (r.created || 0);
    }

    res.json({
      overall: summarizeEnrollments(enrollments),
      perState: buildStateFunnels(enrollments, stateByKey),
      trend: weeklyTrend(enrollments, Date.now()),
      stepFunnel: buildStepFunnel(enrollments),
      deliverability: await deliverabilityStats().catch(() => null),
      coverage: [...coverage.values()],
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── Lead finder (free dispensary discovery) ───────────────────────────────────

// GET /api/outreach/find-leads/status — regions + last sweep per region + the
// suggested next region to expand into.
async function getFinderStatus(req, res) {
  try {
    // Optional ?vertical= scopes the coverage map to one business type; default is
    // dispensaries (the historical view — unchanged when the param is absent).
    const vertical = req.query && isVertical(req.query.vertical) ? req.query.vertical : undefined;
    res.json(await finderStatus({ vertical }));
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// POST /api/outreach/find-leads { region?, dryRun?, maxEnrich? }
// Runs (or previews) a free OSM sweep for a region → scrapes missing emails →
// imports emailable dispensaries as Cold Outreach leads. Bounded + $0.
async function findLeads(req, res) {
  try {
    const body = req.body || {};
    const region = isRegion(body.region) ? body.region : undefined;
    if (body.region && !region) {
      return res.status(400).json({ message: `unknown region "${body.region}"`, regions: Object.keys(REGIONS) });
    }
    const dryRun = body.dryRun === true || body.dryRun === 'true';
    const maxEnrich = Number.isFinite(Number(body.maxEnrich)) ? Number(body.maxEnrich) : undefined;
    const vertical = isVertical(body.vertical) ? body.vertical : undefined;
    const result = await runFinder({ region, dryRun, maxEnrich, vertical });
    res.json(result);
  } catch (e) {
    res.status(502).json({ message: `Lead finder failed: ${e.message}` });
  }
}

// POST /api/outreach/find-leads/auto/run { restart? } — force one lead-engine
// sweep right now (the Studio's "Refill now" button). `restart:true` rewinds
// the frontier to the first state first — the "re-sweep the map" action for
// after the finder improves (dedupe makes it purely additive). The engine
// otherwise runs itself: always on, queue-aware, milking each state dry before
// advancing. (The old on/off toggle endpoint is gone — nothing to turn off.)
async function runAutoNow(req, res) {
  try {
    const fromStart = !!(req.body && (req.body.restart === true || req.body.restart === 'true'));
    const vertical = req.body && isVertical(req.body.vertical) ? req.body.vertical : undefined;
    res.json(await runFrontierSweep({ force: true, fromStart, vertical }));
  } catch (e) {
    res.status(502).json({ message: e.message });
  }
}

// ── Bounce webhook (provider-posted; suppresses dead addresses) ───────────────

// Pull every email address out of an arbitrary provider bounce payload. Walks
// the JSON and collects strings under email-ish keys, so it survives whatever
// shape SendPulse (or any provider) posts. Pure + unit-tested.
function extractBounceEmails(body) {
  const found = new Set();
  const push = (v) => {
    const s = String(v || '').trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) found.add(s);
  };
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /(email|recipient|address|^to$|^rcpt)/i.test(k)) push(v);
      else walk(v);
    }
  };
  walk(body);
  return [...found];
}

// Classify a provider bounce/complaint payload into 'complaint' | 'hard' |
// 'soft' | 'unknown' by walking its event/type/status fields. Only hard bounces
// and complaints should permanently suppress — a soft/transient bounce (full
// mailbox, greylist, temporary block) must NOT kill a good lead forever. Pure.
function classifyBounceEvent(body) {
  let type = '';
  const scan = (s) => {
    const v = String(s || '').toLowerCase();
    if (!type && /(complaint|spam[_\s-]?report|abuse|fbl|feedback[_\s-]?loop)/.test(v)) type = 'complaint';
    else if (!type && /(hard[_\s-]?bounce|permanent|invalid|does[_\s-]?not[_\s-]?exist|unknown[_\s-]?user|no[_\s-]?such|user[_\s-]?unknown|mailbox[_\s-]?(not|unavailable)|5\.\d\.\d)/.test(v)) type = 'hard';
    else if (!type && /(soft[_\s-]?bounce|transient|temporary|deferred|greylist|delay|throttl|mailbox[_\s-]?full|quota|4\.\d\.\d)/.test(v)) type = 'soft';
  };
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && /(event|type|status|category|reason|notification|action|severity|state)/i.test(k)) scan(v);
      else walk(v);
    }
  };
  walk(body);
  return type || 'unknown';
}

// POST /api/outreach/bounce?key=SECRET — a mail provider tells us an address
// bounced/complained; we suppress HARD bounces + complaints everywhere
// (address-level Suppression + doNotEmail + stop any active sequence). SOFT /
// transient bounces are ignored so a full mailbox or greylist can't permanently
// kill a deliverable lead. Guarded by a shared secret (OUTREACH_BOUNCE_SECRET);
// DISABLED entirely until that's set, so it can never be an open endpoint.
async function bounceWebhook(req, res) {
  const secret = process.env.OUTREACH_BOUNCE_SECRET || '';
  if (!secret) return res.status(403).json({ message: 'bounce webhook disabled (set OUTREACH_BOUNCE_SECRET)' });
  const provided = req.query.key || req.headers['x-webhook-key'] || (req.body && req.body.key) || '';
  if (String(provided) !== secret) return res.status(401).json({ message: 'bad key' });

  // Public endpoint (secret-guarded): a stray DB error here must return 500, not
  // become an unhandled rejection that crashes the whole single-dyno API during
  // a bounce burst. Every await below is inside this guard.
  try {
    const event = classifyBounceEvent(req.body);
    const emails = extractBounceEmails(req.body);
    // Soft/transient → record nothing punitive; a later attempt (with backoff) is fine.
    if (event === 'soft') return res.json({ ok: true, event, emails: emails.length, suppressed: 0, skipped: 'soft-bounce' });

    const isComplaint = event === 'complaint';
    const reason = isComplaint ? 'complaint' : 'hard-bounce';
    const source = isComplaint ? 'complaint-webhook' : 'bounce-webhook';
    let suppressed = 0;
    const now = new Date();
    for (const email of emails) {
      // extractBounceEmails lowercases; enrollment toEmail and Client.email are
      // stored as scraped/entered (mixed case happens), so match case-insensitively
      // — otherwise a mixed-case address is suppressed at the address level but its
      // enrollment never flips to 'bounced' and doNotEmail is never set.
      const rx = new RegExp('^' + email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
      // Global address-level suppression first — works even when we have no Client
      // for this address (a bounced lead we never imported). Distinct reason so the
      // deliverability circuit-breaker can tell bounces from complaints.
      await suppress(email, { reason, source });
      const enrs = await OutreachEnrollment.find({ toEmail: rx }).select('companyKey status');
      const keys = new Set();
      for (const e of enrs) {
        keys.add(e.companyKey);
        if (e.status === 'active') { e.status = 'failed'; e.stopReason = isComplaint ? 'complaint' : 'bounced'; e.nextSendAt = null; await e.save().catch(() => {}); }
      }
      const or = [{ email: rx }, { 'contacts.email': rx }];
      if (keys.size) or.push({ companyKey: { $in: [...keys] } });
      const logText = isComplaint ? 'Marked our email as spam — suppressed from outreach' : 'Email bounced — suppressed from outreach';
      const r = await Client.updateMany(
        { $or: or, doNotEmail: { $ne: true } },
        { $set: { doNotEmail: true }, $push: { log: { at: now, text: logText, kind: 'email', dedupKey: `${reason}:${email}` } } },
      ).catch(() => ({ modifiedCount: 0 }));
      suppressed += r.modifiedCount || 0;
    }
    res.json({ ok: true, event, emails: emails.length, suppressed });
  } catch (e) {
    console.error('[outreach] bounceWebhook error:', e.message);
    res.status(500).json({ message: e.message });
  }
}

// POST /api/outreach/recover-sends { confirm: true }
// Undo the damage a SENDER-SIDE failure did before the recipient-only bounce
// classification landed: the old engine treated any 5xx (auth / relay / unverified
// sender / quota) as a dead recipient, so it auto-suppressed the address, flagged
// the company doNotEmail, and failed the enrollment — potentially the whole list on
// one misconfiguration. This reverses ONLY that inline heuristic's marks:
//   • Suppression source 'smtp-bounce'          (NOT webhook bounces/complaints/opt-outs)
//   • doNotEmail set via log 'outreach-bounce:*' (only when no real suppression remains)
//   • enrollment stopReason 'invalid-address' / 'smtp-error'
// and requeues the freed leads. Confirm-gated + idempotent; an address still held by
// a real bounce/complaint/unsubscribe is left blocked.
async function recoverSenderFailures(req, res) {
  try {
    if (!(req.body && (req.body.confirm === true || req.body.confirm === 'true'))) {
      return res.status(400).json({ message: 'confirm required — this requeues leads dropped by sender-side send errors' });
    }
    // 1) Drop the inline heuristic's auto-suppressions. Anything still suppressed
    //    afterward is held by an authoritative source (webhook / unsubscribe).
    const freed = await removeBySource('smtp-bounce');
    const stillSuppressed = await suppressedSet(freed);

    // 2) Clear doNotEmail on companies the inline path flagged — but only when the
    //    address is no longer suppressed by a real source.
    const flagged = await Client.find({
      doNotEmail: true,
      log: { $elemMatch: { dedupKey: { $regex: '^outreach-bounce:' } } },
    }).select('companyKey email contacts').lean();
    const now = new Date();
    const unblockKeys = flagged
      .filter((c) => { const em = String(pickEmail(c) || '').toLowerCase(); return !(em && stillSuppressed.has(em)); })
      .map((c) => c.companyKey);
    let companiesUnblocked = 0;
    if (unblockKeys.length) {
      const r = await Client.updateMany(
        { companyKey: { $in: unblockKeys } },
        { $set: { doNotEmail: false },
          $push: { log: { at: now, text: 'Re-enabled for outreach — the earlier drop was a sender-side error, not a real bounce', kind: 'email', dedupKey: `outreach-recover:${now.getTime()}` } } },
      ).catch(() => ({ modifiedCount: 0 }));
      companiesUnblocked = r.modifiedCount || 0;
    }

    // 3) Requeue the enrollments that were failed by a sender-side error, unless the
    //    address is still genuinely suppressed. Fresh jittered send time so the drip
    //    resumes without a clump.
    const failed = await OutreachEnrollment.find({
      status: 'failed', stopReason: { $in: ['invalid-address', 'smtp-error'] },
    });
    let enrollmentsRequeued = 0;
    for (const enr of failed) {
      const em = String(enr.toEmail || '').toLowerCase();
      if (em && (stillSuppressed.has(em) || await isSuppressed(em))) continue;
      enr.status = 'active';
      enr.stopReason = '';
      enr.lastError = '';
      enr.sendAttempts = 0;
      enr.nextSendAt = new Date(now.getTime() + Math.floor(Math.random() * 90 * 60 * 1000));
      await enr.save().catch(() => {});
      enrollmentsRequeued += 1;
    }

    res.json({
      ok: true,
      freedSuppressions: freed.length,
      stillSuppressed: stillSuppressed.size,
      companiesUnblocked,
      enrollmentsRequeued,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// ── Public routes (no auth — token-keyed) ─────────────────────────────────────

// 1×1 transparent PNG for the open pixel.
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

// GET /api/outreach/t/:token/open.png — open tracking. Never 404s to the mail
// client; an unknown token still gets a pixel.
async function trackOpen(req, res) {
  try {
    const enr = await OutreachEnrollment.findOne({ token: req.params.token });
    if (enr) {
      const now = new Date();
      enr.openCount = (enr.openCount || 0) + 1;
      enr.lastOpenedAt = now;
      const last = enr.sends[enr.sends.length - 1];
      if (last && !last.openedAt) last.openedAt = now;
      await enr.save();
    }
  } catch (e) {
    console.warn('[outreach] open-track failed:', e.message);
  }
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store, no-cache, must-revalidate', Pragma: 'no-cache' });
  res.send(PIXEL_PNG);
}

// GET/POST /api/outreach/u/:token — unsubscribe. Idempotent; flips the
// enrollment AND the company's hard doNotEmail flag, and logs the touch so the
// timeline shows why the sequence went quiet. GET serves humans (link click),
// POST serves one-click List-Unsubscribe.
async function unsubscribe(req, res) {
  let ok = false;
  try {
    const enr = await OutreachEnrollment.findOne({ token: req.params.token });
    if (enr) {
      ok = true;
      const now = new Date();
      if (enr.status === 'active' || enr.status === 'completed') {
        enr.status = 'unsubscribed';
        enr.unsubscribedAt = now;
        enr.nextSendAt = null;
        await enr.save();
      }
      await Client.updateOne(
        { companyKey: enr.companyKey, doNotEmail: { $ne: true } },
        {
          $set: { doNotEmail: true },
          $push: { log: { at: now, text: 'Unsubscribed from outreach emails', kind: 'email', dedupKey: `outreach-unsub:${enr._id}` } },
        },
      );
      // Address-level suppression: never cold-email this inbox again, even if the
      // company is re-discovered under a different companyKey.
      await suppress(enr.toEmail, { reason: 'unsubscribe', source: 'unsubscribe-link' });
    }
  } catch (e) {
    console.warn('[outreach] unsubscribe failed:', e.message);
  }
  if (req.method === 'POST') return res.status(ok ? 200 : 404).json({ ok });
  res.status(200).set('Content-Type', 'text/html').send(
    `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;background:#f6f6f6;margin:0;padding:48px 16px;text-align:center;color:#333;">
<div style="max-width:420px;margin:0 auto;background:#fff;border-radius:8px;padding:32px;">
<h2 style="margin:0 0 8px 0;">You're unsubscribed</h2>
<p style="margin:0;color:#666;">${ok ? "We won't email you again." : 'This link has expired, but if you got an email from us, reply “unsubscribe” and we’ll take care of it.'}</p>
</div></body></html>`,
  );
}

module.exports = {
  getOverview,
  createCampaign,
  updateCampaign,
  launchCampaign,
  getCampaign,
  getCandidates,
  enrollCompanies,
  getQueue,
  markReplied,
  stopEnrollment,
  unenrollAll,
  resetCampaign,
  deleteCampaign,
  setAutoEnroll,
  runAutoEnrollTick,
  startAutoEnroll,
  runTickNow,
  sendTest,
  recheckAuthNow,
  trackOpen,
  unsubscribe,
  getFinderStatus,
  findLeads,
  runAutoNow,
  getAnalytics,
  bounceWebhook,
  recoverSenderFailures,
  // exported for tests
  summarizeEnrollments,
  summarizeAbTest,
  campaignHealth,
  buildNextActions,
  enrollBlockReason,
  sanitizeSteps,
  extractBounceEmails,
  classifyBounceEvent,
  parseState,
  buildStateFunnels,
  weeklyTrend,
  weekStartMs,
  buildStepFunnel,
};
