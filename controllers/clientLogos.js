const ClientLogo = require('../models/ClientLogo');
const { deriveCompanyKey } = require('../models/Order');
const r2 = require('../services/r2');

// Cap stored logos generously — a data URL up to ~3 MB (≈ 2.2 MB raw image
// after base64). Big enough for a real high-res client logo without letting a
// full-res photo bloat the doc. Stays well under the /api/client-logos body
// limit (server.js). Env-overridable.
const MAX_DATA_URL_LEN = Math.max(1, parseInt(process.env.MAX_LOGO_KB, 10) || 3072) * 1024;

// GET /api/client-logos — every logo, for the OrderTracker to map by companyKey.
const listLogos = async (req, res) => {
  try {
    const logos = await ClientLogo.find({}).select('companyKey companyName imageDataUrl uploadedAt').lean();
    res.json({ logos });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/client-logos — { companyName, imageDataUrl } → upserts by companyKey.
const upsertLogo = async (req, res) => {
  try {
    const { companyName = '', clientName = '', imageDataUrl } = req.body;
    if (!imageDataUrl || typeof imageDataUrl !== 'string' || !imageDataUrl.startsWith('data:')) {
      return res.status(400).json({ message: 'imageDataUrl (data:image/...) is required' });
    }
    if (imageDataUrl.length > MAX_DATA_URL_LEN) {
      return res.status(413).json({ message: `Logo too large — keep it under ${(MAX_DATA_URL_LEN / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB.` });
    }
    const companyKey = deriveCompanyKey(companyName, clientName);
    if (!companyKey) return res.status(400).json({ message: 'companyName (or clientName) is required' });

    // Offload the logo to R2 when configured; store the URL in the same field
    // (the frontend renders it via <img src> either way). Falls back to the
    // inline data URL if R2 isn't set up or the upload fails.
    let imageValue = imageDataUrl;
    if (r2.isR2Configured()) {
      try { imageValue = await r2.uploadDataUrl(imageDataUrl, 'logos/img'); }
      catch (e) { console.warn('[clientLogos] R2 upload failed, storing inline:', e.message); }
    }

    // withArchived so an existing archived logo for this company is REVIVED (the
    // companyKey is unique across archived+live, so a plain upsert would otherwise
    // fail to see the archived doc and collide on insert). Re-uploading clears the
    // archived flag — a fresh logo is a live logo.
    const logo = await ClientLogo.findOneAndUpdate(
      { companyKey },
      { $set: { companyKey, companyName, imageDataUrl: imageValue, uploadedAt: new Date(), archived: false, archivedAt: null, archivedReason: '', mergedInto: '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true, withArchived: true },
    );
    res.json({ logo });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// DELETE /api/client-logos/:companyKey
// Soft-delete (house rule): archive the logo, don't destroy it. It drops out of the
// list + every client-facing lookup (all reads exclude archived) so the owner sees it
// disappear as before, but re-uploading the same company revives the row.
const deleteLogo = async (req, res) => {
  try {
    const logo = await ClientLogo.findOneAndUpdate(
      { companyKey: req.params.companyKey },
      { $set: { archived: true, archivedAt: new Date(), archivedReason: 'manual' } },
      { new: true },
    ).select('_id').lean();
    res.json({ deleted: logo ? 1 : 0, archived: !!logo });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

module.exports = { listLogos, upsertLogo, deleteLogo };
