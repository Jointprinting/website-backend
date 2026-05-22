const ClientLogo = require('../models/ClientLogo');
const { deriveCompanyKey } = require('../models/Order');

// Cap stored logos at ~500 KB after base64 (roughly 375 KB raw). Logos
// should be small; bigger uploads suggest someone dropped a full-res photo.
const MAX_DATA_URL_LEN = 700 * 1024;

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
      return res.status(413).json({ message: `Logo too large — keep it under ${Math.round(MAX_DATA_URL_LEN/1024)} KB.` });
    }
    const companyKey = deriveCompanyKey(companyName, clientName);
    if (!companyKey) return res.status(400).json({ message: 'companyName (or clientName) is required' });
    const logo = await ClientLogo.findOneAndUpdate(
      { companyKey },
      { $set: { companyKey, companyName, imageDataUrl, uploadedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    res.json({ logo });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// DELETE /api/client-logos/:companyKey
const deleteLogo = async (req, res) => {
  try {
    const result = await ClientLogo.deleteOne({ companyKey: req.params.companyKey });
    res.json({ deleted: result.deletedCount });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

module.exports = { listLogos, upsertLogo, deleteLogo };
