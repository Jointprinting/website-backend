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
const LeadFinderRun = require('../models/LeadFinderRun');
const Client = require('../models/Client');
const Order = require('../models/Order');
const { PLACED_STATUSES } = require('../models/Order');
const { promoteStage } = require('./crm');

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
const { engineStatus, runOutreachTick, newToken, pickEmail, sendBlockReason } = require('../services/outreachEngine');
const { runFinder, finderStatus } = require('../services/leadFinderRunner');
const { runFrontierSweep, getState } = require('../services/leadFinderScheduler');
const { REGIONS, isRegion } = require('../services/dispensaryFinder');
const { etToday } = require('../utils/time');

const NOT_ARCHIVED = { archived: { $ne: true } };

// ── Pure funnel math (unit-tested) ────────────────────────────────────────────
// One campaign's funnel from its enrollment rows. "opened" and "replied" count
// companies (not events); a replied company also counts as opened when it has
// opens — the UI renders these as funnel stages.
function summarizeEnrollments(rows = []) {
  const s = {
    enrolled: 0, active: 0, sent: 0, opened: 0, replied: 0,
    completed: 0, unsubscribed: 0, stopped: 0, failed: 0,
  };
  for (const e of rows) {
    if (!e) continue;
    s.enrolled += 1;
    if ((e.sends || []).length > 0) s.sent += 1;
    if ((e.openCount || 0) > 0 || e.lastOpenedAt) s.opened += 1;
    if (e.status && s[e.status] != null) s[e.status] += 1;
  }
  return s;
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
    const campaignRows = campaigns.map((c) => ({
      ...c,
      stats: summarizeEnrollments(byCampaign.get(String(c._id)) || []),
    }));
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

    res.json({ engine, campaigns: campaignRows, warm, recent });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// POST /api/outreach/campaigns — create (starts as 'draft'; the owner flips it
// to 'active' once the steps read right).
async function createCampaign(req, res) {
  try {
    const { name, description = '', steps = [] } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ message: 'name required' });
    const campaign = await OutreachCampaign.create({
      name: String(name).trim(),
      description: String(description || ''),
      steps: sanitizeSteps(steps),
    });
    res.json({ campaign });
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
    if ('status' in body) {
      if (!OutreachCampaign.CAMPAIGN_STATUSES.includes(body.status)) {
        return res.status(400).json({ message: `invalid status "${body.status}"` });
      }
      set.status = body.status;
    }
    const campaign = await OutreachCampaign.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    if (!campaign) return res.status(404).json({ message: 'campaign not found' });
    res.json({ campaign });
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
    res.json({ campaign, stats: summarizeEnrollments(enrollments), enrollments });
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
function enrollBlockReason(client, alreadyEnrolled, isCustomerByOrder) {
  if (!client) return 'not-found';
  if (alreadyEnrolled) return 'already-enrolled';
  if (isCustomerByOrder) return 'is-customer';
  const live = sendBlockReason(client); // archived / do-not-email / closed / customer-stage
  if (live) return live;
  if (!pickEmail(client)) return 'no-email';
  return '';
}

// GET /api/outreach/candidates?campaignId=&q=&stage=&leadSource=
// The enroll dialog's pick-list: companies that could go into the campaign
// right now. Cold-outreach audience defaults to lead+contacted; an explicit
// ?stage= narrows further.
async function getCandidates(req, res) {
  try {
    const { campaignId = '', q = '', stage = '', leadSource = '' } = req.query || {};
    const find = { ...NOT_ARCHIVED, doNotEmail: { $ne: true } };
    find.stage = stage ? stage : { $in: ['lead', 'contacted'] };
    if (leadSource) find.leadSource = leadSource;
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

    const rows = clients
      .map((c) => ({ ...c, outreachEmail: pickEmail(c) }))
      .filter((c) => c.outreachEmail && !enrolledKeys.has(c.companyKey) && !customerKeys.has(c.companyKey));
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

    const [clients, existing, customerKeys] = await Promise.all([
      Client.find({ companyKey: { $in: keys } }).lean(),
      OutreachEnrollment.find({ campaignId: campaign._id, companyKey: { $in: keys } })
        .select('companyKey').lean(),
      keysWithPlacedOrders(keys),
    ]);
    const clientByKey = new Map(clients.map((c) => [c.companyKey, c]));
    const enrolledSet = new Set(existing.map((e) => e.companyKey));

    const eligible = [];
    const skipped = [];
    for (const key of keys) {
      const client = clientByKey.get(key) || null;
      const reason = enrollBlockReason(client, enrolledSet.has(key), customerKeys.has(key));
      if (reason) skipped.push({ companyKey: key, reason });
      else eligible.push(client);
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
          nextSendAt: now,
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
    const rows = await OutreachEnrollment.find({ status: 'active' })
      .sort({ nextSendAt: 1 }).limit(100).lean();
    const campaigns = await OutreachCampaign.find({ _id: { $in: [...new Set(rows.map((r) => String(r.campaignId)))] } }).lean();
    const byId = new Map(campaigns.map((c) => [String(c._id), c]));
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
// Stops the sequence and flips the company hot in the CRM: 'warm' tag, follow
// up TODAY (lands in the Today call queue), touch logged, stage → contacted.
async function markReplied(req, res) {
  try {
    const enr = await OutreachEnrollment.findById(req.params.id);
    if (!enr) return res.status(404).json({ message: 'enrollment not found' });
    const now = new Date();
    enr.status = 'replied';
    enr.repliedAt = now;
    enr.nextSendAt = null;
    await enr.save();

    const campaign = await OutreachCampaign.findById(enr.campaignId).lean();
    const client = await Client.findOne({ companyKey: enr.companyKey });
    if (client) {
      const tags = Array.isArray(client.tags) ? client.tags : [];
      if (!tags.some((t) => String(t).toLowerCase() === 'warm')) tags.push('warm');
      client.tags = tags;
      client.nextFollowUp = new Date(`${etToday(now)}T00:00:00.000Z`); // today → Today queue
      client.lastContact = now;
      client.stage = promoteStage(client.stage, 'contacted');
      client.log.push({
        at: now,
        text: `Replied to outreach${campaign ? ` (${campaign.name})` : ''} — follow up today`,
        kind: 'email',
        dedupKey: `outreach-reply:${enr._id}`,
      });
      await client.save();
    }
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
    const b = { weekStart: wk, sent: 0, opened: 0, replied: 0 };
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
  }
  return buckets;
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
    res.json(await finderStatus());
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
    const result = await runFinder({ region, dryRun, maxEnrich });
    res.json(result);
  } catch (e) {
    res.status(502).json({ message: `Lead finder failed: ${e.message}` });
  }
}

// POST /api/outreach/find-leads/auto { enabled?, activeRegion? }
// Toggle the self-advancing auto-pilot and/or jump the frontier to a region.
async function setAutoAdvance(req, res) {
  try {
    const body = req.body || {};
    const state = await getState();
    if ('enabled' in body) state.autoAdvance = body.enabled === true || body.enabled === 'true';
    if (body.activeRegion) {
      if (!isRegion(body.activeRegion)) {
        return res.status(400).json({ message: `unknown region "${body.activeRegion}"` });
      }
      state.activeRegion = body.activeRegion;
      state.dryStreak = 0;
    }
    await state.save();
    res.json(await finderStatus());
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/outreach/find-leads/auto/run — run one auto-pilot tick now (sweep the
// active region + advance the frontier if it's dry), regardless of the toggle.
async function runAutoNow(req, res) {
  try {
    res.json(await runFrontierSweep({ force: true }));
  } catch (e) {
    res.status(502).json({ message: e.message });
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
  getCampaign,
  getCandidates,
  enrollCompanies,
  getQueue,
  markReplied,
  stopEnrollment,
  runTickNow,
  trackOpen,
  unsubscribe,
  getFinderStatus,
  findLeads,
  setAutoAdvance,
  runAutoNow,
  getAnalytics,
  // exported for tests
  summarizeEnrollments,
  enrollBlockReason,
  sanitizeSteps,
  parseState,
  buildStateFunnels,
  weeklyTrend,
  weekStartMs,
};
