// controllers/siteSetting.js
//
// Generic key/value site settings. Each key has its own validator so we can
// enforce shape on write and let reads trust the data. Add new keys here as
// you need them.

const SiteSetting = require('../models/SiteSetting');

// ─────────────────────────────────────────────────────────────────────────────
// Validators per key.
//
// A validator takes the incoming `value` and returns either a cleaned value
// (success) or throws an Error with a user-friendly message (failure).
// Unknown keys are rejected so we don't end up with stray data in the
// settings collection.
// ─────────────────────────────────────────────────────────────────────────────
const VALIDATORS = {
  // The slide-in toast shown on the public /catalogs page. Mirrors the
  // homepage announcement bar but lives in the corner instead of pushing
  // page content down.
  catalogToast: (v) => {
    if (!v || typeof v !== 'object') throw new Error('Expected object value.');
    const clean = {
      enabled:     v.enabled === true,
      headline:    typeof v.headline === 'string' ? v.headline.slice(0, 120) : '',
      code:        typeof v.code === 'string' ? v.code.slice(0, 40) : '',
      subtext:     typeof v.subtext === 'string' ? v.subtext.slice(0, 240) : '',
      accentColor: typeof v.accentColor === 'string' ? v.accentColor.slice(0, 32) : '#1a3d2b',
    };
    return clean;
  },

  // Brand logo (base64 data URL). Rendered on the approval page and confirmation
  // page. Pass { dataUrl: '' } to clear.
  brandLogo: (v) => {
    if (v === null || v === undefined) return { dataUrl: '' };
    if (typeof v !== 'object') throw new Error('Expected { dataUrl }.');
    const dataUrl = typeof v.dataUrl === 'string' ? v.dataUrl : '';
    if (dataUrl && !dataUrl.startsWith('data:')) throw new Error('dataUrl must be a base64 data: URL.');
    if (dataUrl.length > 800 * 1024) throw new Error('Brand logo too large — keep under ~600 KB.');
    return { dataUrl };
  },

  // The Content planner's weekly posting goal — posts per week per platform
  // (0 = paused). The owner sets the pace; 7/week is the sane ceiling.
  socialPace: (v) => {
    if (!v || typeof v !== 'object') throw new Error('Expected object value.');
    const clamp = (n) => Math.max(0, Math.min(7, Math.round(Number(n) || 0)));
    return { linkedin: clamp(v.linkedin), instagram: clamp(v.instagram) };
  },
};

const DEFAULTS = {
  catalogToast: {
    enabled:     false,
    headline:    'Get 10% off your first order from any catalog',
    code:        'CATALOG10',
    subtext:     'Use this code at checkout — fresh prints, fresh discount.',
    accentColor: '#1a3d2b',
  },
  brandLogo: { dataUrl: '' },
  // Start where Nate asked: one LinkedIn + one Instagram post a week.
  socialPace: { linkedin: 1, instagram: 1 },
};

async function getSetting(req, res) {
  try {
    const { key } = req.params;
    if (!VALIDATORS[key]) {
      return res.status(404).json({ message: 'Unknown setting key.' });
    }
    const doc = await SiteSetting.findOne({ key }).lean();
    const value = doc ? doc.value : DEFAULTS[key];
    res.json({ key, value });
  } catch (err) {
    console.error('[siteSetting] get error:', err);
    res.status(500).json({ message: 'Failed to load setting.' });
  }
}

async function setSetting(req, res) {
  try {
    const { key } = req.params;
    const validate = VALIDATORS[key];
    if (!validate) {
      return res.status(400).json({ message: 'Unknown setting key.' });
    }

    let cleaned;
    try {
      cleaned = validate(req.body && req.body.value);
    } catch (validationErr) {
      return res.status(400).json({ message: validationErr.message });
    }

    const doc = await SiteSetting.findOneAndUpdate(
      { key },
      { $set: { value: cleaned, updatedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ key, value: doc.value });
  } catch (err) {
    console.error('[siteSetting] set error:', err);
    res.status(500).json({ message: 'Failed to save setting.' });
  }
}

module.exports = { getSetting, setSetting };
