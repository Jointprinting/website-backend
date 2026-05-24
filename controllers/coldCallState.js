// controllers/coldCallState.js
//
// Backend-persisted Cold Call Tree state — replaces the old browser-localStorage
// store so notes + edits survive a browser data clear and follow the admin
// across devices. Single-document since this is single-admin.

const ColdCallState = require('../models/ColdCallState');

// GET /api/jpw/cold-call-state — always returns a doc shape, even when empty,
// so the frontend can mount without conditionals.
const getState = async (req, res) => {
  try {
    const doc = await ColdCallState.findOne().lean();
    res.json(doc || { biz: '', svc: '', name: '', notes: '', overrides: {}, updatedAt: null });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// PUT /api/jpw/cold-call-state — upserts the single doc. Accepts a partial
// patch so the debounced frontend save can post just what changed.
const updateState = async (req, res) => {
  try {
    const allowed = ['biz', 'svc', 'name', 'notes', 'overrides'];
    const patch = {};
    for (const k of allowed) {
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, k)) {
        patch[k] = req.body[k];
      }
    }
    // Reject malformed overrides shape before it lands in Mongo.
    if (patch.overrides && (typeof patch.overrides !== 'object' || Array.isArray(patch.overrides))) {
      return res.status(400).json({ message: 'overrides must be an object map.' });
    }
    const doc = await ColdCallState.findOneAndUpdate(
      {},
      { $set: patch },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    res.json(doc);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

module.exports = { getState, updateState };
