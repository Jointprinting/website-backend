// controllers/jpwSites.js
//
// JP Webworks site builder API — CRUD for client sites plus the ONE public
// read the preview pages use. The owner's flow: build a site in the Studio
// (draft) → publish the free preview link to show the prospect (preview) →
// client pays → connect their real domain (live). Only preview/live sites are
// publicly readable; drafts 404 so a half-built site can never leak.
//
// Admin routes are gated by requireAdmin in routes/jpwRoutes.js; getPublicSite
// is registered ABOVE that gate (it must be reachable with no token).

const JpwSite = require('../models/JpwSite');
const jpwCopywriter = require('../services/jpwCopywriter');
const aiBudget = require('../services/aiBudget');

// ── Pure helpers (unit-tested in controllers/__tests__/jpwSites.test.js) ─────

// "Cape May Brewing Co." → "cape-may-brewing-co" — the public preview URL part.
function slugifySiteName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/['’]/g, '')                    // "Manny's" → "mannys", not "manny-s"
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'site';
}

const SITE_STATUSES = ['draft', 'preview', 'live'];
// `data` is schemaless by design, but its serialized size is capped so a bad
// paste (or worse) can't balloon a doc toward Mongo's 16MB ceiling.
const MAX_DATA_JSON = 128 * 1024;

// Whitelist + validate a PATCH/PUT body → { set } or { error }. PURE.
function sanitizeSiteUpdate(body = {}) {
  const set = {};
  if (body.name != null) {
    const name = String(body.name).trim();
    if (!name) return { error: 'name cannot be blank' };
    set.name = name.slice(0, 120);
  }
  if (body.businessType != null) set.businessType = String(body.businessType).trim().slice(0, 60);
  if (body.templateId != null) {
    const t = String(body.templateId).trim();
    if (!t) return { error: 'templateId cannot be blank' };
    set.templateId = t.slice(0, 40);
  }
  if (body.status != null) {
    if (!SITE_STATUSES.includes(body.status)) return { error: `status must be one of ${SITE_STATUSES.join(', ')}` };
    set.status = body.status;
  }
  if (body.domain != null) {
    // Bare hostname only — strip scheme/path/spaces so "https://shop.com/" saves as "shop.com".
    const dom = String(body.domain).trim().toLowerCase()
      .replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/\s+/g, '');
    set.domain = dom.slice(0, 200);
  }
  if (body.data != null) {
    if (typeof body.data !== 'object' || Array.isArray(body.data)) return { error: 'data must be an object' };
    let size = 0;
    try { size = JSON.stringify(body.data).length; } catch { return { error: 'data is not serializable' }; }
    if (size > MAX_DATA_JSON) return { error: `data too large (${size} bytes; max ${MAX_DATA_JSON})` };
    set.data = body.data;
  }
  return { set };
}

// The public subset of a site — everything a rendered page needs, nothing the
// Studio-only surfaces (no _id, no timestamps). PURE.
function publicSiteView(site) {
  if (!site) return null;
  return {
    slug: site.slug,
    name: site.name,
    templateId: site.templateId,
    businessType: site.businessType || '',
    status: site.status,
    data: site.data || {},
  };
}

// ── Admin CRUD ────────────────────────────────────────────────────────────────

// GET /api/jpw/sites — newest first (the Studio list).
async function listSites(req, res) {
  try {
    const sites = await JpwSite.find({}).sort({ updatedAt: -1 }).lean();
    res.json({ sites });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// POST /api/jpw/sites { name, businessType?, templateId, data? }
// Slug derives from the name; a collision gets a -2/-3… suffix so two clients
// named "Main Street Deli" both get working preview URLs.
async function createSite(req, res) {
  try {
    const body = req.body || {};
    const { set, error } = sanitizeSiteUpdate({
      name: body.name, businessType: body.businessType || '',
      templateId: body.templateId, data: body.data || {},
    });
    if (error) return res.status(400).json({ message: error });
    if (!set.name) return res.status(400).json({ message: 'name is required' });
    if (!set.templateId) return res.status(400).json({ message: 'templateId is required' });

    const base = slugifySiteName(set.name);
    let slug = base;
    for (let n = 2; await JpwSite.exists({ slug }); n++) slug = `${base}-${n}`;

    // The exists()-loop → create() pair is not atomic: two same-name creates can
    // race and the loser hits the unique slug index (E11000). Retry once from
    // the collided slug rather than surfacing a raw Mongo error.
    try {
      const site = await JpwSite.create({ ...set, slug, status: 'draft' });
      return res.status(201).json({ site: site.toObject() });
    } catch (e) {
      if (e && e.code === 11000) {
        for (let n = 2; await JpwSite.exists({ slug }); n++) slug = `${base}-${n}`;
        try {
          const site = await JpwSite.create({ ...set, slug, status: 'draft' });
          return res.status(201).json({ site: site.toObject() });
        } catch (e2) {
          if (e2 && e2.code === 11000) {
            return res.status(400).json({ message: 'A site with a very similar name was just created — try again.' });
          }
          throw e2;
        }
      }
      throw e;
    }
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// GET /api/jpw/sites/:id
async function getSite(req, res) {
  try {
    const site = await JpwSite.findById(req.params.id).lean();
    if (!site) return res.status(404).json({ message: 'site not found' });
    res.json({ site });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// PUT /api/jpw/sites/:id — whitelisted patch (name/businessType/templateId/
// status/domain/data). Slug is immutable after create: the preview URL the
// owner already texted a prospect must never silently die.
async function updateSite(req, res) {
  try {
    const { set, error } = sanitizeSiteUpdate(req.body || {});
    if (error) return res.status(400).json({ message: error });
    if (!Object.keys(set).length) return res.status(400).json({ message: 'nothing to update' });
    const site = await JpwSite.findByIdAndUpdate(req.params.id, { $set: set }, { new: true, runValidators: true }).lean();
    if (!site) return res.status(404).json({ message: 'site not found' });
    res.json({ site });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// DELETE /api/jpw/sites/:id
async function deleteSite(req, res) {
  try {
    const gone = await JpwSite.findByIdAndDelete(req.params.id).lean();
    if (!gone) return res.status(404).json({ message: 'site not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// POST /api/jpw/sites/:id/generate { brief, tone? } — write the whole site's
// copy from the owner's brief using the shared Anthropic integration. Admin
// only. Deliberately does NOT save: it returns the copy for the frontend to
// merge into the live editor draft, so the owner reviews before normal autosave
// persists it. Feature-flagged on ANTHROPIC_API_KEY.
async function generateCopy(req, res) {
  try {
    if (!jpwCopywriter.isConfigured()) {
      return res.status(400).json({ message: "AI copywriting isn't enabled — set ANTHROPIC_API_KEY on the API." });
    }
    const site = await JpwSite.findById(req.params.id).lean();
    if (!site) return res.status(404).json({ message: 'site not found' });

    const brief = String((req.body && req.body.brief) || '').trim();
    if (!brief) {
      return res.status(400).json({ message: 'Add a few notes about the business so the AI has something to work from.' });
    }
    const tone = req.body && req.body.tone;

    // AI-credit guardrail: a cheap check BEFORE we spend a single token. Refuses
    // when this month's estimated spend has hit the budget, or the day's generate
    // count has hit its cap — so a runaway loop can't silently drain the balance.
    const guard = await aiBudget.preflight();
    if (!guard.ok) return res.status(guard.status).json({ message: guard.message });

    const result = await jpwCopywriter.generateSiteCopy({
      businessName: site.name,
      businessType: site.businessType,
      templateId: site.templateId,
      brief,
      tone,
    });
    // The service never throws — a model/SDK failure comes back as { error }.
    if (result.error) return res.status(502).json({ message: result.error });

    // Record estimated spend from the call's usage. Best-effort: a bookkeeping
    // hiccup must NEVER break the copy the owner just generated.
    try {
      if (result.meta && result.meta.usage) await aiBudget.recordUsage(result.meta.usage);
    } catch (e) {
      console.error('[jpwSites] AI usage record failed:', e && e.message);
    }

    return res.json({ data: result.data, meta: result.meta });
  } catch (e) {
    return res.status(502).json({ message: e.message || 'AI copywriting failed' });
  }
}

// GET /api/jpw/ai-usage — the AI-credit snapshot the Studio hub + JPW Websites
// tab render (admin only). `configured` mirrors whether AI copywriting is even
// enabled; `level` is 'ok' | 'warn' (>=80% of budget) | 'blocked' (>=100%).
async function getAiUsage(_req, res) {
  try {
    const status = await aiBudget.getStatus();
    return res.json({ configured: jpwCopywriter.isConfigured(), ...status });
  } catch (e) {
    return res.status(500).json({ message: e.message || 'Failed to read AI usage.' });
  }
}

// ── Public read (NO auth — registered above the requireAdmin gate) ───────────

// GET /api/jpw/sites/public/:slug — what /webworks/p/<slug> renders. Drafts and
// unknown slugs both 404 identically (no existence oracle for half-built sites).
async function getPublicSite(req, res) {
  try {
    const slug = String(req.params.slug || '').toLowerCase().trim();
    const site = await JpwSite.findOne({ slug, status: { $in: ['preview', 'live'] } }).lean();
    if (!site) return res.status(404).json({ message: 'not found' });
    res.json({ site: publicSiteView(site) });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// Request-Host → comparable hostname: lowercase, strip port, strip a leading
// "www." (clients type domains both ways; the stored domain may carry either
// form too, so lookups compare both sides normalized). PURE + unit-tested.
function normalizeHost(host) {
  return String(host || '').toLowerCase().trim()
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

// GET /api/jpw/sites/public/domain/:host — the hostname-routing lookup behind a
// client's CONNECTED domain: the React app asks "does this Host belong to a
// live client site?" and renders it instead of the marketing shell. Only LIVE
// sites resolve (a preview stays on its /webworks/p/<slug> link until the
// client pays); unknown hosts 404 and the app falls through to the normal site.
async function getPublicSiteByDomain(req, res) {
  try {
    const host = normalizeHost(req.params.host);
    if (!host) return res.status(404).json({ message: 'not found' });
    // The stored domain may or may not carry "www." — match both forms.
    const site = await JpwSite.findOne({ domain: { $in: [host, `www.${host}`] }, status: 'live' }).lean();
    if (!site) return res.status(404).json({ message: 'not found' });
    res.json({ site: publicSiteView(site) });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

module.exports = {
  listSites, createSite, getSite, updateSite, deleteSite, generateCopy, getAiUsage, getPublicSite, getPublicSiteByDomain,
  // pure helpers (unit-tested)
  slugifySiteName, sanitizeSiteUpdate, publicSiteView, normalizeHost, SITE_STATUSES,
};
