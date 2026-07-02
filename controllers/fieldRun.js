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
const { optimizeStopOrder } = require('../services/routeOptimize');

function todayLabel() { return new Date().toISOString().slice(0, 10); }

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

// ── POST /api/roadtrip/run/stops ─────────────────────────────────────────────
// Body: { dispensaryId } | { leadId, name, lat, lng, ... } | a bare custom
// stop { name, lat, lng, address?, phone? }. Dedupes by dispensaryId/leadId/
// placeId so double-taps don't double-book.
async function addStop(req, res) {
  try {
    const run = await ensureActiveRun();
    const b = req.body || {};

    let stop = null;
    if (b.dispensaryId) {
      if (run.stops.some((s) => String(s.dispensaryId) === String(b.dispensaryId))) {
        return res.json({ run, duplicate: true });
      }
      const d = await Dispensary.findById(b.dispensaryId).lean();
      if (!d) return res.status(404).json({ message: 'Dispensary not found.' });
      if (!isFinite(d.lat) || !isFinite(d.lng) || d.lat == null) {
        return res.status(400).json({ message: 'That store has no coordinates yet — run enrichment first.' });
      }
      stop = {
        dispensaryId: d._id,
        name: d.name,
        address: [d.address, d.city].filter(Boolean).join(', '),
        phone: d.phone,
        lat: d.lat, lng: d.lng,
        placeId: d.placeId,
        chainName: d.chainName,
        companyKey: d.companyKey,
      };
    } else {
      const lat = parseFloat(b.lat), lng = parseFloat(b.lng);
      if (!b.name || !isFinite(lat) || !isFinite(lng)) {
        return res.status(400).json({ message: 'name, lat, lng are required for a custom stop.' });
      }
      if (b.leadId && run.stops.some((s) => String(s.leadId) === String(b.leadId))) {
        return res.json({ run, duplicate: true });
      }
      stop = {
        leadId: b.leadId || null,
        name: String(b.name),
        address: String(b.address || ''),
        phone: String(b.phone || ''),
        lat, lng,
        placeId: String(b.placeId || ''),
        chainName: String(b.chainName || ''),
        companyKey: String(b.companyKey || ''),
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
