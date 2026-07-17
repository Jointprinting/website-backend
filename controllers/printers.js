// controllers/printers.js
//
// Printer network API — the quoter's printer picker + the reference pricing
// behind it. Owner-only. The nexus rule lives here so every surface agrees:
// a printer is ELIGIBLE for a job when its home state differs from the job's
// ship-to state (the owner can't route a job through a printer in the same
// state he's shipping to). We surface eligibility, never hard-block — the
// owner always has the final say.

const fs = require('fs');
const path = require('path');
const Printer = require('../models/Printer');
const { validateSection, capabilitiesFromCatalog } = require('../utils/printerCatalog');

// YYYY-MM-DD (UTC) — the format capturedOn / pricingReviewedOn use, so a fresh
// stamp resets pricingReviewDue's yearly nudge.
const today = () => new Date().toISOString().slice(0, 10);
// The audit actor: the owner token's username (auth middleware), 'studio' fallback.
const actor = (req) => (req && req.user && req.user.username) || 'studio';

// GET /api/printers?shipToState=NJ — light list for pickers. Catalog bodies
// stay out of the list payload (they're big); fetch one printer for detail.
async function listPrinters(req, res) {
  try {
    const shipTo = String(req.query.shipToState || '').trim().toUpperCase();
    const printers = await Printer.find({ active: true })
      .select('key name state location capabilities catalogEffective notes contacts capturedOn pricingReviewedOn sourcePdfUrl').lean();
    res.json({
      printers: printers.map((p) => ({
        ...p,
        // Nexus eligibility only means something once a ship-to state is known.
        // We surface it, never hard-block — same-state printers grey out with a
        // reason on the client, they're never hidden.
        eligible: shipTo ? (String(p.state).toUpperCase() !== shipTo) : null,
        // Yearly re-verify nudge: is this sheet more than a year past its capture?
        reviewDue: Printer.pricingReviewDue(p),
      })),
      shipToState: shipTo || null,
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// GET /api/printers/:key — full doc incl. the price catalog.
async function getPrinter(req, res) {
  try {
    const p = await Printer.findOne({ key: String(req.params.key || '').toLowerCase() }).lean();
    if (!p) return res.status(404).json({ message: 'Printer not found.' });
    res.json({ printer: p });
  } catch (e) { res.status(500).json({ message: e.message }); }
}

// Boot-time seed (server.js, flag-guarded per catalog drop): upsert each
// data/printerCatalog-*.json into the registry. Same zero-friction path as
// the promo catalog: new printer PDF → scraped JSON in data/ → next deploy.
// `opts.forceContactsFor` — a set/array of printer keys whose contacts should be
// REFRESHED from the committed catalog even on an existing row (normally contacts
// are insert-only to preserve owner edits). Used once when a catalog's contact was
// corrected after the printer had already been seeded (e.g. a fixed email), for
// printers the owner hasn't hand-edited yet.
async function seedPrinters(opts = {}) {
  const forceContacts = new Set((opts.forceContactsFor || []).map((k) => String(k).toLowerCase()));
  // Full re-import of a printer's price book + meta from the committed sheet — the
  // deliberate escape hatch that DOES overwrite app edits (a corrected PDF drop).
  const forceAll = new Set((opts.forceCatalogFor || []).map((k) => String(k).toLowerCase()));
  const dir = path.join(__dirname, '..', 'data');
  const files = fs.readdirSync(dir).filter((f) => /^printerCatalog-.+\.json$/.test(f));
  let seeded = 0;
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const p = raw.printer || {};
    const key = String(f.replace(/^printerCatalog-/, '').replace(/\.json$/, '')).toLowerCase();
    const { printer, meta, ...catalogSections } = raw;
    const contacts = Array.isArray(p.contacts) ? p.contacts : [];
    const contact = p.contact || null;
    const derivedCaps = capabilitiesFromCatalog(catalogSections);
    // The committed JSON is the INITIAL IMPORT. Capabilities derive from the
    // actual price sections (4D). Everything is imported INSERT-ONLY so the
    // in-Studio catalog editor is authoritative afterward — a re-deploy that
    // re-runs the seed can never clobber an owner's price/meta/contact edit.
    const importFields = {
      name: p.name || key,
      state: p.state || '',
      location: p.location || '',
      capabilities: derivedCaps.length ? derivedCaps : (Array.isArray(p.capabilities) ? p.capabilities : []),
      catalog: catalogSections,
      catalogEffective: (meta && (meta.revisedEffective || meta.effective)) || '',
      capturedOn: (meta && meta.capturedOn) || '',
      sourcePdfUrl: (meta && meta.sourcePdf) || p.sourcePdfUrl || '',
    };
    let update;
    if (forceAll.has(key)) {
      // Deliberate full re-import: overwrite whatever's in the DB from the sheet.
      update = { $set: { ...importFields, contacts, contact } };
    } else {
      // Normal path: insert-only. On an existing printer this is a no-op, so app
      // edits survive; a brand-new committed catalog seeds once. `forceContactsFor`
      // still refreshes just the contacts for a one-time contact correction.
      update = { $setOnInsert: { ...importFields } };
      if (forceContacts.has(key)) update.$set = { contacts, contact };
      else { update.$setOnInsert.contacts = contacts; update.$setOnInsert.contact = contact; }
    }
    await Printer.updateOne({ key }, update, { upsert: true });
    seeded += 1;
  }
  return { seeded };
}

// ── App-writable catalog (4B): the in-Studio editor's write path ─────────────
// All owner-only (the router is behind requireAdmin). Every catalog write
// re-derives capabilities (4D) and re-captures the pricing date so the yearly
// re-verify nudge resets. Archived sections move to `catalogArchive` (out of
// `catalog`) so the Quoter never prices them, but stay recoverable.

// POST /api/printers — add a printer the owner just signed (no committed JSON needed).
async function createPrinter(req, res) {
  try {
    const b = req.body || {};
    const key = String(b.key || b.name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '').slice(0, 40);
    if (!key) return res.status(400).json({ message: 'A printer name (or key) is required.' });
    if (!String(b.name || '').trim()) return res.status(400).json({ message: 'A printer name is required.' });
    if (await Printer.findOne({ key }).lean()) return res.status(409).json({ message: `A printer keyed "${key}" already exists.` });
    const p = await Printer.create({
      key,
      name: String(b.name).trim(),
      state: String(b.state || '').toUpperCase().trim().slice(0, 2),
      location: String(b.location || '').trim(),
      notes: String(b.notes || '').trim(),
      catalog: {},
      capabilities: [],
      capturedOn: today(),
      editedAt: new Date(), editedBy: actor(req),
    });
    res.status(201).json({ printer: p });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// PATCH /api/printers/:key — edit owner-facing meta / contacts, or stamp a re-verify.
const META_FIELDS = ['name', 'location', 'notes', 'catalogEffective', 'sourcePdfUrl'];
async function updatePrinter(req, res) {
  try {
    const key = String(req.params.key || '').toLowerCase();
    const p = await Printer.findOne({ key });
    if (!p) return res.status(404).json({ message: 'Printer not found.' });
    const b = req.body || {};
    for (const f of META_FIELDS) if (b[f] !== undefined) p[f] = String(b[f] ?? '').trim();
    if (b.state !== undefined) p.state = String(b.state || '').toUpperCase().trim().slice(0, 2);
    if (b.active !== undefined) p.active = !!b.active;
    if (Array.isArray(b.contacts)) {
      p.contacts = b.contacts.map((c) => ({
        name: String(c.name || '').trim(), email: String(c.email || '').trim(),
        role: String(c.role || '').trim(), primary: !!c.primary,
      }));
    }
    // "Pricing reviewed today" — the owner confirms the sheet still holds, clearing
    // the yearly re-verify nudge (pricingReviewDue reads pricingReviewedOn).
    if (b.markReviewed) p.pricingReviewedOn = today();
    p.editedAt = new Date(); p.editedBy = actor(req);
    await p.save();
    res.json({ printer: p });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// PUT /api/printers/:key/catalog/:section — create or replace one price book
// section (the model-tagged grid the Quoter engine reads).
async function putCatalogSection(req, res) {
  try {
    const key = String(req.params.key || '').toLowerCase();
    const sectionKey = String(req.params.section || '').trim();
    const body = (req.body && req.body.section !== undefined) ? req.body.section : req.body;
    const v = validateSection(sectionKey, body);
    if (!v.ok) return res.status(400).json({ message: v.error });
    const p = await Printer.findOne({ key });
    if (!p) return res.status(404).json({ message: 'Printer not found.' });
    const catalog = (p.catalog && typeof p.catalog === 'object') ? { ...p.catalog } : {};
    catalog[sectionKey] = body;
    p.catalog = catalog; p.markModified('catalog');
    // Un-archive if this section was previously archived.
    if (p.catalogArchive && p.catalogArchive[sectionKey]) {
      const arch = { ...p.catalogArchive }; delete arch[sectionKey];
      p.catalogArchive = Object.keys(arch).length ? arch : undefined; p.markModified('catalogArchive');
    }
    p.capabilities = capabilitiesFromCatalog(catalog);
    p.capturedOn = today(); p.pricingReviewedOn = today();
    p.editedAt = new Date(); p.editedBy = actor(req);
    p.catalogLog = [...(p.catalogLog || []), { at: new Date(), by: actor(req), section: sectionKey, action: 'edit' }].slice(-50);
    await p.save();
    res.json({ printer: p });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

// DELETE /api/printers/:key/catalog/:section — soft-archive a section (recoverable).
async function archiveCatalogSection(req, res) {
  try {
    const key = String(req.params.key || '').toLowerCase();
    const sectionKey = String(req.params.section || '').trim();
    const p = await Printer.findOne({ key });
    if (!p) return res.status(404).json({ message: 'Printer not found.' });
    const catalog = (p.catalog && typeof p.catalog === 'object') ? { ...p.catalog } : {};
    if (catalog[sectionKey] === undefined) return res.status(404).json({ message: `No "${sectionKey}" section on this printer.` });
    const arch = { ...(p.catalogArchive || {}) };
    arch[sectionKey] = catalog[sectionKey];    // keep it recoverable
    delete catalog[sectionKey];                // out of the effective catalog — Quoter won't price it
    p.catalog = catalog; p.markModified('catalog');
    p.catalogArchive = arch; p.markModified('catalogArchive');
    p.capabilities = capabilitiesFromCatalog(catalog);
    p.editedAt = new Date(); p.editedBy = actor(req);
    p.catalogLog = [...(p.catalogLog || []), { at: new Date(), by: actor(req), section: sectionKey, action: 'archive' }].slice(-50);
    await p.save();
    res.json({ printer: p });
  } catch (e) { res.status(400).json({ message: e.message }); }
}

module.exports = {
  listPrinters, getPrinter, seedPrinters,
  createPrinter, updatePrinter, putCatalogSection, archiveCatalogSection,
};
