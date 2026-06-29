const StudioMockupVersion = require('../models/StudioMockupVersion');
const r2 = require('../services/r2');

// Keep the newest N versions per mockup cloud-side (the studio keeps a similar
// local cap). Generous — versions are small once the composites are R2 URLs.
const VERSION_CAP = 30;

// POST /api/studio/versions — push one version snapshot. Hash-deduped against the
// mockup's newest stored version (an unchanged open/save adds nothing), composites
// offloaded to R2, then the per-mockup history is pruned to VERSION_CAP.
async function saveVersion(req, res) {
  try {
    let { mockupRemoteId, versionRemoteId, name, mockupNum, client, trigger, hash, thumbnail, data, pageState, savedAt } = req.body;
    if (!mockupRemoteId) return res.status(400).json({ message: 'mockupRemoteId required.' });

    // Dedup: if the newest stored snapshot for this mockup has the same hash, skip.
    if (hash) {
      const newest = await StudioMockupVersion.findOne({ mockupRemoteId }).sort({ savedAt: -1 }).select('hash').lean();
      if (newest && newest.hash === hash) return res.json({ deduped: true });
    }

    if (r2.isR2Configured()) {
      try {
        [thumbnail, data] = await Promise.all([
          r2.uploadDataUrl(thumbnail, 'versions/img'),
          r2.uploadDataUrl(data, 'versions/img'),
        ]);
      } catch (e) {
        console.warn('[studioVersions] R2 upload failed, storing inline:', e.message);
      }
    }

    const doc = await StudioMockupVersion.create({
      mockupRemoteId,
      versionRemoteId: versionRemoteId || '',
      name: name || '', mockupNum: mockupNum || '', client: client || '',
      trigger: trigger || 'edit', hash: hash || '',
      thumbnail: thumbnail || '', data: data || '',
      pageState: pageState || null,
      savedAt: savedAt || Date.now(),
    });

    // Prune to the newest VERSION_CAP for this mockup; free the R2 objects the
    // dropped versions owned (best-effort — paid-storage cleanup never fails us).
    const extra = await StudioMockupVersion.find({ mockupRemoteId })
      .sort({ savedAt: -1 }).skip(VERSION_CAP).select('_id thumbnail data').lean();
    if (extra.length) {
      extra.forEach((e) => {
        try {
          if (r2.isR2Url(e.thumbnail)) r2.deleteByUrl(e.thumbnail);
          if (r2.isR2Url(e.data)) r2.deleteByUrl(e.data);
        } catch (_) { /* ignore */ }
      });
      await StudioMockupVersion.deleteMany({ _id: { $in: extra.map((e) => e._id) } });
    }

    res.status(201).json({ id: String(doc._id), versionRemoteId: doc.versionRemoteId, savedAt: doc.savedAt });
  } catch (err) {
    console.error('[studioVersions] save error:', err);
    res.status(500).json({ message: err.message || 'Failed to save version.', code: err.code || err.name || undefined });
  }
}

// GET /api/studio/versions/:mockupRemoteId — the lightweight history list
// (metadata + thumbnail only; never the heavy pageState).
async function listVersions(req, res) {
  try {
    const items = await StudioMockupVersion.find({ mockupRemoteId: req.params.mockupRemoteId })
      .sort({ savedAt: -1 }).limit(60)
      .select('mockupRemoteId versionRemoteId name mockupNum client trigger hash thumbnail savedAt').lean();
    res.json(items);
  } catch (err) {
    console.error('[studioVersions] list error:', err);
    res.status(500).json({ message: 'Failed to list versions.' });
  }
}

// GET /api/studio/version/:versionRemoteId — one full version (pageState + back
// composite) for a restore. Accepts the version's remoteId or its Mongo _id.
async function getVersion(req, res) {
  try {
    const key = req.params.versionRemoteId;
    let item = await StudioMockupVersion.findOne({ versionRemoteId: key }).lean();
    if (!item && /^[a-f0-9]{24}$/i.test(key)) item = await StudioMockupVersion.findById(key).lean();
    if (!item) return res.status(404).json({ message: 'Version not found.' });
    res.json(item);
  } catch (err) {
    console.error('[studioVersions] get error:', err);
    res.status(500).json({ message: 'Failed to load version.' });
  }
}

module.exports = { saveVersion, listVersions, getVersion };
