// controllers/fieldRun.js
//
// Today's Run — one active FieldRun at a time. The flow the Field Map drives:
//   tap pins → POST stops → POST optimize (from current location) → the
//   frontend builds chunked Google Maps handoff links → PATCH stops visited
//   as the day unfolds → POST complete when done.
//
// Marking a stop visited also stamps Dispensary.lastVisitedAt so pins carry
// visit history beyond the life of the run. CRM writes (opportunity/to-do)
// go through the CRM's own upsert from the frontend — this controller stays
// pure trip logistics.

const FieldRun = require('../models/FieldRun');
const Dispensary = require('../models/Dispensary');
const Client = require('../models/Client');
const { optimizeStopOrder } = require('../services/routeOptimize');
const { matchKey } = require('../services/dispensaryIngest');

function todayLabel() { return new Date().toISOString().slice(0, 10); }

// Resolve the CRM card a stop belongs to, with the SAME precedence as the
// map's pin join (listDispensaries): the exact companyKey match wins, the
// fuzzier matchKey is only a fallback — so a stop never binds to a different
// card than the pin the owner tapped. Resolved ONCE at add time and carried
// on the stop, so logging an outcome/to-do later (often with the map panned
// far away) writes toward the card's REAL key instead of a derived-key
// duplicate; patchOne re-resolves field-map writes at write time as the
// backstop for cards created after the stop was added. A merged-away
// duplicate is never bound — its history lives on the surviving card.
// Best-effort: a lookup failure just means no match.
const NOT_MERGED_LOSER = { $nor: [{ archived: true, archivedReason: 'merged' }] };
async function resolveCrmMatch(companyKey, dispMatchKey) {
  try {
    let c = companyKey
      ? await Client.findOne({ companyKey, ...NOT_MERGED_LOSER }).select('companyKey stage').lean()
      : null;
    if (!c && dispMatchKey) {
      c = await Client.findOne({ matchKey: dispMatchKey, ...NOT_MERGED_LOSER }).select('companyKey stage').lean();
    }
    return c;
  } catch {
    return null;
  }
}

async function ensureActiveRun() {
  let run = await FieldRun.findOne({ active: true }).sort({ createdAt: -1 });
  if (!run) run = await FieldRun.create({ label: todayLabel(), active: true, stops: [] });
  return run;
}

// ── GET /api/roadtrip/run ────────────────────────────────────────────────────
async function getCurrent(_req, res) {
  try {
    const run = await FieldRun.findOne({ active: true }).sort({ createdAt: -1 }).lean();
    res.json({ run: run || null });
  } catch (err) {
    res.status(500).json({ message: 'Run lookup failed.' });
  }
}

// Both coordinates present and real. NB: global isFinite(null) === true, so
// the null checks are load-bearing — one lng-less doc must be skipped, not
// blow up the whole run.save() on the schema's required lng.
function hasCoords(d) {
  return d && d.lat != null && d.lng != null && isFinite(d.lat) && isFinite(d.lng);
}

// Assemble a run stop from a Dispensary doc + its resolved CRM match.
function stopFromDispensary(d, crm) {
  return {
    dispensaryId: d._id,
    name: d.name,
    address: [d.address, d.city].filter(Boolean).join(', '),
    phone: d.phone,
    lat: d.lat, lng: d.lng,
    placeId: d.placeId,
    chainName: d.chainName,
    companyKey: (crm && crm.companyKey) || d.companyKey,
    crmStage: (crm && crm.stage) || '',
  };
}

// ── POST /api/roadtrip/run/stops ─────────────────────────────────────────────
// Body: { dispensaryId } | { dispensaryIds: [...] } (bulk "add all in view")
// | { leadId, name, lat, lng, ... } | a bare custom stop { name, lat, lng,
// address?, phone? }. Dedupes by dispensaryId/leadId/placeId so double-taps
// (and re-bulk-adds of an area) don't double-book.
const BULK_ADD_CAP = 80;

async function addStop(req, res) {
  try {
    const run = await ensureActiveRun();
    const b = req.body || {};

    // Bulk path — the "save them all" day-planning flow: search a city, add
    // every store in view in one tap. Already-added stops and stores without
    // coordinates are skipped, not errors; order continues from the tray's end.
    if (Array.isArray(b.dispensaryIds)) {
      const ids = b.dispensaryIds.slice(0, BULK_ADD_CAP).map(String);
      const have = new Set(run.stops.map((s) => String(s.dispensaryId)));
      let order = run.stops.length ? Math.max(...run.stops.map((s) => s.order)) + 1 : 0;
      let added = 0, skipped = 0;
      const docs = await Dispensary.find({ _id: { $in: ids } }).lean();
      const byId = new Map(docs.map((d) => [String(d._id), d]));
      for (const id of ids) {
        const d = byId.get(id);
        if (!d || have.has(id) || !hasCoords(d)) { skipped++; continue; }
        const crm = await resolveCrmMatch(d.companyKey, d.matchKey || matchKey(d.name));
        const stop = stopFromDispensary(d, crm);
        stop.order = order++;
        run.stops.push(stop);
        have.add(id);
        added++;
      }
      if (added) await run.save();
      return res.json({ run, added, skipped, capped: b.dispensaryIds.length > BULK_ADD_CAP });
    }

    let stop = null;
    if (b.dispensaryId) {
      if (run.stops.some((s) => String(s.dispensaryId) === String(b.dispensaryId))) {
        return res.json({ run, duplicate: true });
      }
      const d = await Dispensary.findById(b.dispensaryId).lean();
      if (!d) return res.status(404).json({ message: 'Dispensary not found.' });
      if (!hasCoords(d)) {
        return res.status(400).json({ message: 'That store has no coordinates yet — run enrichment first.' });
      }
      const crm = await resolveCrmMatch(d.companyKey, d.matchKey || matchKey(d.name));
      stop = stopFromDispensary(d, crm);
    } else {
      const lat = parseFloat(b.lat), lng = parseFloat(b.lng);
      if (!b.name || !isFinite(lat) || !isFinite(lng)) {
        return res.status(400).json({ message: 'name, lat, lng are required for a custom stop.' });
      }
      if (b.leadId && run.stops.some((s) => String(s.leadId) === String(b.leadId))) {
        return res.json({ run, duplicate: true });
      }
      // Custom stops (friends, favors, hand-typed places) match by EXACT
      // companyKey only — a fuzzy name match could bind "Green Leaf" (a
      // friend's shop) to the unrelated company "Green Leaf, LLC" and write
      // field visits into its record. Dispensary stops are companies by
      // definition; custom pins aren't.
      const crm = await resolveCrmMatch(String(b.companyKey || ''), '');
      stop = {
        leadId: b.leadId || null,
        name: String(b.name),
        address: String(b.address || ''),
        phone: String(b.phone || ''),
        lat, lng,
        placeId: String(b.placeId || ''),
        chainName: String(b.chainName || ''),
        companyKey: (crm && crm.companyKey) || String(b.companyKey || ''),
        crmStage: (crm && crm.stage) || '',
      };
    }

    stop.order = run.stops.length ? Math.max(...run.stops.map((s) => s.order)) + 1 : 0;
    run.stops.push(stop);
    await run.save();
    res.json({ run });
  } catch (err) {
    console.error('[fieldRun] addStop error:', err.message);
    res.status(500).json({ message: 'Add stop failed.' });
  }
}

// ── DELETE /api/roadtrip/run/stops/:stopId ───────────────────────────────────
async function removeStop(req, res) {
  try {
    const run = await FieldRun.findOne({ active: true }).sort({ createdAt: -1 });
    if (!run) return res.status(404).json({ message: 'No active run.' });
    const before = run.stops.length;
    run.stops = run.stops.filter((s) => String(s._id) !== String(req.params.stopId));
    if (run.stops.length === before) return res.status(404).json({ message: 'Stop not found.' });
    await run.save();
    res.json({ run });
  } catch (err) {
    res.status(500).json({ message: 'Remove stop failed.' });
  }
}

// ── PATCH /api/roadtrip/run/stops/:stopId  {status?, outcome?} ───────────────
async function patchStop(req, res) {
  try {
    const run = await FieldRun.findOne({ active: true }).sort({ createdAt: -1 });
    if (!run) return res.status(404).json({ message: 'No active run.' });
    const stop = run.stops.find((s) => String(s._id) === String(req.params.stopId));
    if (!stop) return res.status(404).json({ message: 'Stop not found.' });

    const b = req.body || {};
    if (b.status !== undefined) {
      if (!FieldRun.STOP_STATUSES.includes(b.status)) {
        return res.status(400).json({ message: `invalid status "${b.status}"` });
      }
      stop.status = b.status;
      stop.visitedAt = b.status === 'visited' ? new Date() : null;
      if (b.status === 'visited' && stop.dispensaryId) {
        await Dispensary.updateOne({ _id: stop.dispensaryId }, { $set: { lastVisitedAt: stop.visitedAt } });
      }
    }
    if (b.outcome !== undefined) stop.outcome = String(b.outcome);
    await run.save();
    res.json({ run });
  } catch (err) {
    res.status(500).json({ message: 'Update stop failed.' });
  }
}

// ── POST /api/roadtrip/run/optimize  {lat, lng} ──────────────────────────────
// Reorders PENDING stops from the given start point (the owner's current
// location). Visited/skipped stops keep their place at the head of the list
// in the order they happened — the run reads as "done, then what's next".
async function optimize(req, res) {
  try {
    const lat = parseFloat(req.body?.lat), lng = parseFloat(req.body?.lng);
    if (!isFinite(lat) || !isFinite(lng)) {
      return res.status(400).json({ message: 'lat and lng (current location) are required.' });
    }
    const run = await FieldRun.findOne({ active: true }).sort({ createdAt: -1 });
    if (!run || !run.stops.length) return res.status(404).json({ message: 'No stops to optimize.' });

    const done = run.stops.filter((s) => s.status !== 'pending')
      .sort((a, b) => (a.visitedAt || 0) - (b.visitedAt || 0));
    const pending = run.stops.filter((s) => s.status === 'pending');
    const { order, miles } = optimizeStopOrder({ lat, lng }, pending.map((s) => ({ lat: s.lat, lng: s.lng })));

    let i = 0;
    for (const s of done) s.order = i++;
    for (const idx of order) pending[idx].order = i++;
    run.startLat = lat;
    run.startLng = lng;
    run.stops.sort((a, b) => a.order - b.order);
    await run.save();
    res.json({ run, miles: Math.round(miles * 10) / 10 });
  } catch (err) {
    console.error('[fieldRun] optimize error:', err.message);
    res.status(500).json({ message: 'Optimize failed.' });
  }
}

// ── PATCH /api/roadtrip/run  {stopOrder: [stopId, ...]} ─────────────────────
// Manual reorder (drag / move up-down in the tray).
async function patchRun(req, res) {
  try {
    const run = await FieldRun.findOne({ active: true }).sort({ createdAt: -1 });
    if (!run) return res.status(404).json({ message: 'No active run.' });
    const ids = Array.isArray(req.body?.stopOrder) ? req.body.stopOrder.map(String) : null;
    if (ids) {
      const pos = new Map(ids.map((id, i) => [id, i]));
      for (const s of run.stops) {
        const p = pos.get(String(s._id));
        if (p !== undefined) s.order = p;
      }
      run.stops.sort((a, b) => a.order - b.order);
    }
    if (req.body?.label !== undefined) run.label = String(req.body.label);
    await run.save();
    res.json({ run });
  } catch (err) {
    res.status(500).json({ message: 'Update run failed.' });
  }
}

// ── POST /api/roadtrip/run/complete ──────────────────────────────────────────
// Archives the active run (history kept). The next added stop starts a fresh
// one.
async function completeRun(_req, res) {
  try {
    const run = await FieldRun.findOne({ active: true }).sort({ createdAt: -1 });
    if (!run) return res.status(404).json({ message: 'No active run.' });
    run.active = false;
    run.endedAt = new Date();
    await run.save();
    res.json({ run });
  } catch (err) {
    res.status(500).json({ message: 'Complete run failed.' });
  }
}

module.exports = { getCurrent, addStop, removeStop, patchStop, optimize, patchRun, completeRun };
