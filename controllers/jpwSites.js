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

    const site = await JpwSite.create({ ...set, slug, status: 'draft' });
    res.status(201).json({ site: site.toObject() });
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

module.exports = {
  listSites, createSite, getSite, updateSite, deleteSite, getPublicSite,
  // pure helpers (unit-tested)
  slugifySiteName, sanitizeSiteUpdate, publicSiteView, SITE_STATUSES,
};
