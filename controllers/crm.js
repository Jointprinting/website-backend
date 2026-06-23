// controllers/crm.js
//
// The unified CRM, built on the existing Client record (one row per company,
// keyed by companyKey — the same key Orders use). Nothing here changes how
// Client is used by orders/auto-fill; it only adds CRM read/write surfaces.
//
// Endpoints (all admin-only, mounted at /api/crm):
//   GET  /                       list (?stage=&area=&q=)
//   GET  /today                  the "who do I call today" engine
//   GET  /calendar?from=&to=     follow-ups in a date window (month grid)
//   GET  /:companyKey            one record + its Orders
//   PATCH /:companyKey           upsert/update; supports log-touch & reschedule
//   POST /import                 bulk upsert from field-tracker rows / CSV

const Client = require('../models/Client');
const Order  = require('../models/Order');
const { deriveCompanyKey } = require('../models/Order'); // REUSE canonical key normalization
const { parseCsv, rowsToObjects, mapTrackerRow } = require('../utils/fieldTrackerImport');

const STAGES = Client.CRM_STAGES;
// Stages we never surface in the call engine — the deal is closed or parked.
const CLOSED_STAGES = ['won', 'lost', 'dormant'];

// End of *today* in server-local time, as a Date (used by /today).
function endOfTodayLocal() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}
function startOfTodayLocal() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

// Most-recent log entry (the log is appended chronologically; we don't assume
// it's sorted, so pick the max `at`).
function lastLogEntry(log) {
  if (!Array.isArray(log) || log.length === 0) return null;
  let best = null;
  for (const e of log) {
    if (!best || new Date(e.at || 0) >= new Date(best.at || 0)) best = e;
  }
  return best || null;
}

// GET /api/crm — list with optional filters, sorted by name. Lean.
async function listCrm(req, res) {
  try {
    const { stage, area, q } = req.query;
    const filter = {};
    if (stage && STAGES.includes(stage)) filter.stage = stage;
    if (area) filter.area = area;
    if (q && String(q).trim()) {
      const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ companyName: rx }, { clientName: rx }, { companyKey: rx }];
    }
    const clients = await Client.find(filter).sort({ companyName: 1 }).lean();
    res.json({ clients });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// GET /api/crm/today — the call engine.
// Records with nextFollowUp <= end of today AND stage not in closed stages,
// sorted overdue-first then soonest. Returns a compact row per record plus a
// count summary { overdue, dueToday }.
async function getToday(req, res) {
  try {
    const endToday   = endOfTodayLocal();
    const startToday = startOfTodayLocal();

    const docs = await Client.find({
      nextFollowUp: { $ne: null, $lte: endToday },
      stage: { $nin: CLOSED_STAGES },
    })
      .sort({ nextFollowUp: 1 })   // soonest/most-overdue first (oldest date first)
      .lean();

    let overdue = 0;
    let dueToday = 0;
    const rows = docs.map((c) => {
      const nf = c.nextFollowUp ? new Date(c.nextFollowUp) : null;
      const isOverdue = nf && nf < startToday;
      if (isOverdue) overdue++; else dueToday++;
      const last = lastLogEntry(c.log);
      return {
        companyKey:   c.companyKey,
        name:         c.companyName || c.clientName || c.companyKey,
        phone:        c.phone || '',
        contacts:     c.contacts || [],
        stage:        c.stage,
        interestType: c.interestType || '',
        area:         c.area || '',
        nextFollowUp: c.nextFollowUp || null,
        lastContact:  c.lastContact || null,
        overdue:      !!isOverdue,
        lastLog:      last ? { at: last.at, text: last.text, kind: last.kind } : null,
      };
    });

    // ascending nextFollowUp already puts most-overdue first; that's exactly
    // "overdue-first then soonest". Keep as-is.
    res.json({
      summary: { overdue, dueToday, total: rows.length },
      rows,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// GET /api/crm/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
// Records whose nextFollowUp falls within [from, to] inclusive. Returns a slim
// shape suited to a month grid.
async function getCalendar(req, res) {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ message: 'from and to (YYYY-MM-DD) are required' });
    const start = new Date(`${from}T00:00:00`);
    const end   = new Date(`${to}T23:59:59.999`);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({ message: 'from/to must be valid YYYY-MM-DD dates' });
    }
    const docs = await Client.find({
      nextFollowUp: { $ne: null, $gte: start, $lte: end },
    })
      .sort({ nextFollowUp: 1 })
      .select('companyKey companyName clientName phone stage interestType area nextFollowUp lastContact')
      .lean();

    const events = docs.map((c) => ({
      companyKey:   c.companyKey,
      name:         c.companyName || c.clientName || c.companyKey,
      phone:        c.phone || '',
      stage:        c.stage,
      interestType: c.interestType || '',
      area:         c.area || '',
      nextFollowUp: c.nextFollowUp,
      lastContact:  c.lastContact || null,
    }));
    res.json({ from, to, events });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// GET /api/crm/:companyKey — one record (get-or-create stub) + its Orders.
async function getOne(req, res) {
  try {
    const key = req.params.companyKey;
    if (!key) return res.status(400).json({ message: 'companyKey required' });

    let client = await Client.findOne({ companyKey: key }).lean();
    if (!client) {
      // Bootstrap an empty stub from any existing order so the record exists
      // and lines up with order history — mirrors controllers/clients.js.
      const sample = await Order.findOne({ companyKey: key })
        .sort({ updatedAt: -1 })
        .select('companyName clientName')
        .lean();
      const created = await Client.create({
        companyKey:  key,
        companyName: (sample && sample.companyName) || '',
        clientName:  (sample && sample.clientName)  || '',
      });
      client = created.toObject();
    }

    const orders = await Order.find({ companyKey: key })
      .sort({ orderDate: -1, createdAt: -1 })
      .select('projectNumber orderNumber status paid totalValue cogs orderDate createdAt')
      .lean();

    res.json({ client, orders });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
}

// Fields a normal PATCH may set directly.
const PATCHABLE = [
  'companyName', 'clientName', 'email', 'phone', 'paymentTerms',
  'defaultPrinter', 'defaultSupplier', 'defaultMarkup', 'notes',
  'stage', 'nextFollowUp', 'lastContact', 'area', 'interestType',
  'dealValue', 'contacts', 'source',
];

// PATCH /api/crm/:companyKey — upsert/update CRM fields.
// Two helper intents (composable with plain field edits):
//   • log a touch: { logText, kind?, nextFollowUp? }
//       → append { at: now, text: logText, kind } to log
//       → set lastContact = now
//       → set nextFollowUp if provided
//   • reschedule:  { nextFollowUp }  (no logText)
//       → just move the date (powers calendar drag-and-drop)
// Get-or-create by companyKey (reusing normalization is unnecessary here — the
// key is supplied — but we never let a non-empty value be clobbered implicitly).
async function patchOne(req, res) {
  try {
    const key = req.params.companyKey;
    if (!key) return res.status(400).json({ message: 'companyKey required' });
    const body = req.body || {};

    const set = {};
    const push = {};

    // Plain field edits.
    for (const f of PATCHABLE) {
      if (f in body) {
        if (f === 'stage' && body.stage && !STAGES.includes(body.stage)) {
          return res.status(400).json({ message: `invalid stage "${body.stage}"` });
        }
        set[f] = body[f];
      }
    }

    // Intent: log a touch.
    const hasLog = typeof body.logText === 'string' && body.logText.trim() !== '';
    if (hasLog) {
      const now = new Date();
      push.log = { at: now, text: body.logText.trim(), kind: (body.kind || 'note') };
      set.lastContact = now;
      if ('nextFollowUp' in body) set.nextFollowUp = body.nextFollowUp || null;
    }

    // Intent: reschedule (only when not also logging — logging already handled
    // nextFollowUp above). A bare { nextFollowUp } just moves the date.
    if (!hasLog && 'nextFollowUp' in body) {
      set.nextFollowUp = body.nextFollowUp || null;
    }

    set.companyKey = key;

    const update = {};
    if (Object.keys(set).length)  update.$set  = set;
    if (Object.keys(push).length) update.$push = push;

    const client = await Client.findOneAndUpdate(
      { companyKey: key },
      update,
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean();

    res.json({ client });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// ── Import ────────────────────────────────────────────────────────────────────
// Merge one mapped tracker patch into the (possibly existing) Client doc.
// Rules:
//   • fill blanks only — never clobber a non-empty existing field with an
//     empty import value;
//   • dates: set lastContact/nextFollowUp only when parsed AND (empty before OR
//     the imported date is newer for lastContact / sooner-but-future is fine);
//   • contacts: add the imported primary contact if not already present (by
//     name+email);
//   • log: append all import notes (history is additive);
//   • stage: only upgrade a default/empty stage — don't downgrade a record the
//     owner already advanced.
// Returns 'created' | 'updated' | 'skipped'.
async function applyMappedRow(mapped) {
  if (mapped._skip || !mapped.companyKey) return 'skipped';
  const key = mapped.companyKey;

  let doc = await Client.findOne({ companyKey: key });
  const isNew = !doc;
  if (!doc) {
    doc = new Client({ companyKey: key, source: 'field-tracker' });
  }

  // Names / scalar text — fill blanks only.
  if (mapped.companyName && !doc.companyName) doc.companyName = mapped.companyName;
  if (mapped.area && !doc.area) doc.area = mapped.area;
  if (mapped.phone && !doc.phone) doc.phone = mapped.phone;
  if (mapped.email && !doc.email) doc.email = mapped.email;
  if (mapped.interestType && !doc.interestType) doc.interestType = mapped.interestType;
  if (!doc.source) doc.source = 'field-tracker';

  // Stage: only set when the import has a stage AND the doc is still at the
  // default 'lead' (or empty) — never override an owner-advanced stage.
  if (mapped.stage && (!doc.stage || doc.stage === 'lead')) {
    doc.stage = mapped.stage;
  }

  // Dates. lastContact: take the newer of existing/import. nextFollowUp: fill
  // if empty, otherwise keep the EARLIER upcoming date (don't push a call later).
  if (mapped.lastContact) {
    if (!doc.lastContact || mapped.lastContact > doc.lastContact) doc.lastContact = mapped.lastContact;
  }
  if (mapped.nextFollowUp) {
    if (!doc.nextFollowUp || mapped.nextFollowUp < doc.nextFollowUp) doc.nextFollowUp = mapped.nextFollowUp;
  }

  // Primary contact — add if a matching one (by name+email, case-insensitive)
  // isn't already on the record.
  if (mapped.contact) {
    const c = mapped.contact;
    const exists = (doc.contacts || []).some((ec) =>
      (ec.name || '').toLowerCase() === (c.name || '').toLowerCase() &&
      (ec.email || '').toLowerCase() === (c.email || '').toLowerCase());
    if (!exists && (c.name || c.email || c.phone)) doc.contacts.push(c);
  }

  // Log notes — always append (history is additive). De-dupe identical
  // (kind+text) lines that are already present so re-importing the same file
  // doesn't pile up duplicates.
  const existingLogKeys = new Set((doc.log || []).map((l) => `${l.kind} ${l.text}`));
  for (const ln of (mapped.logs || [])) {
    const k = `${ln.kind} ${ln.text}`;
    if (!existingLogKeys.has(k)) {
      doc.log.push({ at: new Date(), text: ln.text, kind: ln.kind });
      existingLogKeys.add(k);
    }
  }

  await doc.save();
  return isNew ? 'created' : 'updated';
}

// POST /api/crm/import — accepts EITHER:
//   { rows: [ { "Company Name": ..., ... }, ... ] }   (objects keyed by header)
//   { rows: [...] } where rows already match canonical keys
//   { csv: "<raw csv text>" }                          (we parse it)
//   a bare JSON array body                              (treated as rows)
// Upserts Client/CRM by companyKey; never wipes existing data.
// Returns { created, updated, skipped, total }.
async function importRows(req, res) {
  try {
    const body = req.body;
    const year = Number(body && body.year) || 2026;

    let mappedRows = [];

    if (body && typeof body.csv === 'string' && body.csv.trim()) {
      const objs = rowsToObjects(parseCsv(body.csv));
      mappedRows = objs.map((o) => mapTrackerRow(o, { year }));
    } else {
      let rows = [];
      if (Array.isArray(body)) rows = body;
      else if (body && Array.isArray(body.rows)) rows = body.rows;
      else return res.status(400).json({ message: 'Provide { rows: [...] } or { csv: "..." }' });

      mappedRows = rows.map((r) => {
        // Accept either header-keyed objects ("Company Name") or canonical keys
        // ("companyName"). Normalize header-keyed → canonical via a tiny shim.
        const canon = normalizeRowKeys(r);
        return mapTrackerRow(canon, { year });
      });
    }

    let created = 0, updated = 0, skipped = 0;
    for (const mapped of mappedRows) {
      let outcome;
      try {
        outcome = await applyMappedRow(mapped);
      } catch (rowErr) {
        // Don't let one bad row abort the whole import.
        outcome = 'skipped';
      }
      if (outcome === 'created') created++;
      else if (outcome === 'updated') updated++;
      else skipped++;
    }

    res.json({ created, updated, skipped, total: mappedRows.length });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
}

// Accept rows keyed by the owner's headers OR by canonical names; produce a
// canonical-keyed object that mapTrackerRow understands.
const HEADER_TO_CANON = {
  'company name': 'companyName',
  'owner / contact': 'contact',
  'owner/contact': 'contact',
  'contact': 'contact',
  'phone': 'phone',
  'email': 'email',
  'area': 'area',
  'interested?': 'interested',
  'interested': 'interested',
  'status': 'status',
  'last contact': 'lastContact',
  'next contact': 'nextContact',
  'next action': 'nextAction',
  'notes': 'notes',
  // canonical passthroughs
  'companyname': 'companyName',
  'lastcontact': 'lastContact',
  'nextcontact': 'nextContact',
  'nextaction': 'nextAction',
};
function normalizeRowKeys(row) {
  if (!row || typeof row !== 'object') return {};
  const out = {};
  for (const k of Object.keys(row)) {
    const canon = HEADER_TO_CANON[String(k).trim().toLowerCase()];
    if (canon) out[canon] = row[k];
  }
  return out;
}

module.exports = {
  listCrm,
  getToday,
  getCalendar,
  getOne,
  patchOne,
  importRows,
  // exported for tests
  applyMappedRow,
  normalizeRowKeys,
};
