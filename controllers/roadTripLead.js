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
  // New sales fields:
  'score', 'contactEmail', 'followUpDate',
  'visitOutcome', 'itemInterests',
  'existingVendor', 'referredBy', 'customType',
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
  // existingVendor is a boolean; coerce string 'true'/'false' from form bodies
  if (out.existingVendor !== undefined) {
    out.existingVendor = out.existingVendor === true || out.existingVendor === 'true';
  }
  return out;
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
