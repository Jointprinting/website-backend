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
  const force = new Set((opts.forceContactsFor || []).map((k) => String(k).toLowerCase()));
  const dir = path.join(__dirname, '..', 'data');
  const files = fs.readdirSync(dir).filter((f) => /^printerCatalog-.+\.json$/.test(f));
  let seeded = 0;
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const p = raw.printer || {};
    const key = String(f.replace(/^printerCatalog-/, '').replace(/\.json$/, '')).toLowerCase();
    const { printer, meta, ...catalogSections } = raw;
    // Never clobber owner edits: contacts + the pricing-review stamp are
    // hand-editable in the app, so seed them ONLY on first insert ($setOnInsert),
    // while pricing/state/catalog always refresh from the committed sheet ($set).
    const contacts = Array.isArray(p.contacts) ? p.contacts : [];
    const contact = p.contact || null;
    const set = {
      name: p.name || key,
      state: p.state || '',
      location: p.location || '',
      capabilities: Array.isArray(p.capabilities) ? p.capabilities : [],
      catalog: catalogSections,
      catalogEffective: (meta && (meta.revisedEffective || meta.effective)) || '',
      capturedOn: (meta && meta.capturedOn) || '',
      sourcePdfUrl: (meta && meta.sourcePdf) || p.sourcePdfUrl || '',
    };
    const update = { $set: set };
    // Both the singular `contact` and the `contacts` array are hand-editable in the
    // app, so seed them ONLY on first insert — a re-seed must never clobber an owner
    // edit. (Before, `contact` sat in $set and every re-seed overwrote it.) `force`
    // refreshes both for a one-time catalog contact correction.
    if (force.has(key)) { set.contacts = contacts; set.contact = contact; }
    else update.$setOnInsert = { contacts, contact };
    await Printer.updateOne({ key }, update, { upsert: true });
    seeded += 1;
  }
  return { seeded };
}

module.exports = { listPrinters, getPrinter, seedPrinters };
