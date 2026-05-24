// controllers/roadTripLead.js
//
// CRUD for road-trip leads + admin management of the dispensary denylist.
// All write endpoints are gated by requireAdmin in the route file. Reads
// require admin too — leads are private business data.

const RoadTripLead = require('../models/RoadTripLead');
const DispensaryDenylist = require('../models/DispensaryDenylist');

// ── Leads ────────────────────────────────────────────────────────────────────

const ALLOWED_LEAD_FIELDS = [
  'source', 'externalId',
  'name', 'address', 'phone', 'website',
  'lat', 'lng',
  'type', 'kind', 'status',
  'contactName', 'notes', 'visitedAt',
  'tripLabel', 'dayLabel', 'sortOrder',
  // Sales fields:
  'score', 'contactEmail', 'followUpDate',
  'visitOutcome', 'itemInterests',
  'existingVendor', 'referredBy', 'customType',
  // Sleep slot fields (TONIGHT chip):
  'sleepRole', 'sleepKind', 'isActiveSleep',
];

function pickAllowed(body) {
  const out = {};
  for (const k of ALLOWED_LEAD_FIELDS) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  if (out.lat !== undefined) out.lat = parseFloat(out.lat);
  if (out.lng !== undefined) out.lng = parseFloat(out.lng);
  if (out.sortOrder !== undefined) out.sortOrder = parseInt(out.sortOrder, 10) || 0;
  // itemInterests must stay an array, not be coerced to a number
  if (out.itemInterests !== undefined && !Array.isArray(out.itemInterests)) {
    out.itemInterests = [out.itemInterests];
  }
  // existingVendor + isActiveSleep are booleans; coerce 'true'/'false' from form bodies
  if (out.existingVendor !== undefined) {
    out.existingVendor = out.existingVendor === true || out.existingVendor === 'true';
  }
  if (out.isActiveSleep !== undefined) {
    out.isActiveSleep = out.isActiveSleep === true || out.isActiveSleep === 'true';
  }
  return out;
}

// Soft-enforce one primary + one backup + one active sleep per (tripLabel,
// dayLabel). When the incoming write claims a slot, demote any prior holder
// of the same slot on the same day. Single-writer system — a unique index
// would be stricter but would conflict with frequent dayLabel reshuffling.
async function demoteOtherSleepHolders(updates, excludeId = null) {
  const tripLabel = updates.tripLabel ?? '';
  const dayLabel = updates.dayLabel ?? '';
  // If dayLabel isn't being set, we don't know which day to clean up — bail.
  if (!dayLabel) return;

  if (updates.sleepRole === 'primary' || updates.sleepRole === 'backup') {
    const filter = {
      tripLabel, dayLabel, sleepRole: updates.sleepRole,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    };
    await RoadTripLead.updateMany(filter, {
      $set: { sleepRole: '', sleepKind: '', isActiveSleep: false },
    });
  }
  if (updates.isActiveSleep === true) {
    const filter = {
      tripLabel, dayLabel, isActiveSleep: true,
      ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    };
    await RoadTripLead.updateMany(filter, { $set: { isActiveSleep: false } });
  }
}

async function listLeads(req, res) {
  try {
    const filter = {};
    if (req.query.tripLabel) filter.tripLabel = req.query.tripLabel;
    if (req.query.type)      filter.type      = req.query.type;
    if (req.query.kind)      filter.kind      = req.query.kind;
    if (req.query.status)    filter.status    = req.query.status;
    const leads = await RoadTripLead.find(filter).sort({ createdAt: -1 }).lean();
    res.json(leads);
  } catch (err) {
    console.error('[roadTripLead] list error:', err);
    res.status(500).json({ message: 'Failed to list leads.' });
  }
}

async function createLead(req, res) {
  try {
    const data = pickAllowed(req.body);
    if (!data.name) return res.status(400).json({ message: 'name is required.' });
    if (!isFinite(data.lat) || !isFinite(data.lng)) {
      return res.status(400).json({ message: 'lat and lng are required.' });
    }
    // Prevent duplicate captures of the same external place. If the user
    // really wants two copies, they can edit the name and re-add manually.
    if (data.externalId) {
      const existing = await RoadTripLead.findOne({ externalId: data.externalId }).lean();
      if (existing) {
        return res.status(409).json({
          message: `This place is already saved as a lead (status: ${existing.status}).`,
          existing,
        });
      }
    }
    await demoteOtherSleepHolders(data);
    const created = await RoadTripLead.create(data);
    res.status(201).json(created);
  } catch (err) {
    console.error('[roadTripLead] create error:', err);
    res.status(500).json({ message: 'Failed to create lead.' });
  }
}

async function updateLead(req, res) {
  try {
    const updates = pickAllowed(req.body);
    // If a sleep slot or active flag is being claimed and we don't have a
    // dayLabel in the body, look up the lead's current dayLabel so we can
    // demote correctly.
    if ((updates.sleepRole === 'primary' || updates.sleepRole === 'backup'
         || updates.isActiveSleep === true) && updates.dayLabel === undefined) {
      const current = await RoadTripLead.findById(req.params.id).lean();
      if (current) updates.dayLabel = current.dayLabel;
      if (current) updates.tripLabel = current.tripLabel;
    }
    await demoteOtherSleepHolders(updates, req.params.id);
    const lead = await RoadTripLead.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    res.json(lead);
  } catch (err) {
    console.error('[roadTripLead] update error:', err);
    res.status(500).json({ message: 'Failed to update lead.' });
  }
}

async function deleteLead(req, res) {
  try {
    const lead = await RoadTripLead.findByIdAndDelete(req.params.id);
    if (!lead) return res.status(404).json({ message: 'Lead not found.' });
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    console.error('[roadTripLead] delete error:', err);
    res.status(500).json({ message: 'Failed to delete lead.' });
  }
}

// ── Denylist ────────────────────────────────────────────────────────────────

async function listDenylist(_req, res) {
  try {
    const entries = await DispensaryDenylist.find({}).sort({ addedAt: -1 }).lean();
    res.json(entries);
  } catch (err) {
    res.status(500).json({ message: 'Failed to list denylist.' });
  }
}

async function addDenylist(req, res) {
  try {
    const { placeId, name = '', reason = '' } = req.body || {};
    if (!placeId) return res.status(400).json({ message: 'placeId is required.' });
    const entry = await DispensaryDenylist.findOneAndUpdate(
      { placeId },
      { $set: { placeId, name, reason } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json(entry);
  } catch (err) {
    console.error('[roadTripLead] addDenylist error:', err);
    res.status(500).json({ message: 'Failed to add to denylist.' });
  }
}

async function removeDenylist(req, res) {
  try {
    await DispensaryDenylist.deleteOne({ placeId: req.params.placeId });
    res.json({ deleted: true, placeId: req.params.placeId });
  } catch (err) {
    res.status(500).json({ message: 'Failed to remove from denylist.' });
  }
}

module.exports = {
  listLeads, createLead, updateLead, deleteLead,
  listDenylist, addDenylist, removeDenylist,
};
