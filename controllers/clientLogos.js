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

// ── Legacy inline logos ──────────────────────────────────────────────────────
//
// upsertLogo offloads to R2 when it is configured, storing a URL in the same
// field. But every logo uploaded BEFORE R2 was set up still holds its full
// base64 data URL inline — up to 3 MB each, in the document.
//
// That matters because listLogos returns every logo in one response so the
// Order Tracker can map them by companyKey. An R2-backed logo costs ~80 bytes
// of URL; an inline one costs megabytes. The response size is therefore exactly
// the size of the legacy backlog, on a 512 MB dyno.
//
// Report first, move second — the standing rule for anything touching live data.

const isInline = (v) => typeof v === 'string' && v.startsWith('data:');

// GET /api/client-logos/inline — how much is still inline, and what it weighs.
// Read-only. Reports rather than fixing, so the owner sees the scope before
// anything moves.
const inlineReport = async (req, res) => {
  try {
    const logos = await ClientLogo.find({}).select('companyKey companyName imageDataUrl').lean();
    const inline = logos.filter((l) => isInline(l.imageDataUrl));
    const bytes = inline.reduce((n, l) => n + (l.imageDataUrl || '').length, 0);
    res.json({
      r2Configured: r2.isR2Configured(),
      total: logos.length,
      inline: inline.length,
      // What the whole-list response currently costs, which is the number that
      // decides whether this is worth doing.
      inlineBytes: bytes,
      inlineMb: Math.round((bytes / 1024 / 1024) * 100) / 100,
      rows: inline
        .map((l) => ({
          companyKey: l.companyKey,
          companyName: l.companyName || '',
          kb: Math.round((l.imageDataUrl || '').length / 1024),
        }))
        .sort((a, b) => b.kb - a.kb),
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// POST /api/client-logos/inline/migrate  { confirm: true }
//
// Push the inline ones to R2 and replace the field with the URL. The image the
// frontend renders is identical either way — it is an <img src> in both cases —
// so nothing visible changes.
//
// Requires an explicit confirm, does one logo at a time, and NEVER clears a
// logo it failed to upload: a partial run leaves the rest inline and working,
// and re-running picks up where it stopped. Idempotent by construction, because
// an already-migrated logo no longer matches isInline.
const migrateInline = async (req, res) => {
  try {
    if (!req.body || req.body.confirm !== true) {
      return res.status(400).json({ message: 'Pass { confirm: true } to move these to R2.' });
    }
    if (!r2.isR2Configured()) {
      return res.status(400).json({ message: 'R2 is not configured, so there is nowhere to move them.' });
    }
    const logos = await ClientLogo.find({}).select('companyKey imageDataUrl').lean();
    const inline = logos.filter((l) => isInline(l.imageDataUrl));

    const moved = [];
    const failed = [];
    for (const l of inline) {
      try {
        const url = await r2.uploadDataUrl(l.imageDataUrl, 'logos/img');
        // Only write the URL once the upload actually returned one. Writing a
        // failed upload's result would destroy the only copy of the logo.
        if (!url || !r2.isR2Url(url)) throw new Error('upload did not return an R2 url');
        await ClientLogo.updateOne({ companyKey: l.companyKey }, { $set: { imageDataUrl: url } });
        moved.push(l.companyKey);
      } catch (e) {
        failed.push({ companyKey: l.companyKey, error: e.message });
      }
    }
    res.json({ ok: true, moved: moved.length, failed, remaining: inline.length - moved.length });
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

module.exports = {
  listLogos, upsertLogo, deleteLogo,
  // Legacy inline → R2. Report first, move only on an explicit confirm.
  inlineReport, migrateInline,
};
