// controllers/scriptVersion.js
//
// CRUD for cold-call script versions (admin-only). Used by the Studio cold-call
// tool — Nate edits a line, it gets saved here as a new version. Versions are
// per-device-shared via MongoDB so saving on the laptop carries to the phone.

const ScriptVersion = require('../models/ScriptVersion');

const ALLOWED_FIELDS = ['script', 'followUp', 'voicemail', 'direction'];

// GET /api/script-versions
// Returns ALL saved versions, grouped client-side. Cheap because the collection
// is bounded (a few dozen rows max — one studio user, finite node/field combos).
exports.listAll = async (req, res) => {
  try {
    const versions = await ScriptVersion.find().sort({ createdAt: -1 }).lean();
    res.json({ versions });
  } catch (err) {
    console.error('listAll script versions error:', err);
    res.status(500).json({ message: 'Could not load script versions.' });
  }
};

// POST /api/script-versions
// Body: { nodeId, field, text, label? }
exports.create = async (req, res) => {
  try {
    const { nodeId, field, text, label } = req.body || {};

    if (!nodeId || typeof nodeId !== 'string') {
      return res.status(400).json({ message: 'nodeId is required.' });
    }
    if (!ALLOWED_FIELDS.includes(field)) {
      return res.status(400).json({ message: `field must be one of: ${ALLOWED_FIELDS.join(', ')}` });
    }
    if (!text || typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ message: 'text is required.' });
    }
    if (text.length > 8000) {
      return res.status(400).json({ message: 'text is too long (max 8000 chars).' });
    }

    const version = await ScriptVersion.create({
      nodeId: nodeId.trim(),
      field,
      text: text.trim(),
      label: typeof label === 'string' ? label.trim().slice(0, 80) : '',
    });

    res.status(201).json({ version });
  } catch (err) {
    console.error('create script version error:', err);
    res.status(500).json({ message: 'Could not save script version.' });
  }
};

// DELETE /api/script-versions/:id
exports.remove = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await ScriptVersion.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ message: 'Version not found.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('delete script version error:', err);
    res.status(500).json({ message: 'Could not delete script version.' });
  }
};
