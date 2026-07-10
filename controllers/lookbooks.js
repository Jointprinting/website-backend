// controllers/lookbooks.js
//
// Lookbooks — the curated, shareable mockup galleries a client actually
// reviews (models/Lookbook.js has the full story). Two surfaces:
//
//   ADMIN (routes/lookbookRoutes.js, requireAdmin, /api/lookbooks)
//     GET    /                 list (?companyKey; archived hidden by default)
//     POST   /                 create
//     GET    /:id              one lookbook + resolved mockup tiles
//     PATCH  /:id              edit title/subtitle/pages/layout/status
//     POST   /:id/share        mint/rotate the share token → live client link
//     POST   /:id/feedback/seen  acknowledge client feedback (clears the signal)
//
//   PUBLIC (routes/publicLookbookRoutes.js, token-gated, /api/public/lookbooks)
//     GET    /:id?token=…      the client gallery payload
//     POST   /:id/feedback     👍/👎 + comment on a mockup (or the whole book)
//
// Delete is an archive (status:'archived') — house rule, nothing hard-deletes.
// The PDF export stays on the existing generator (POST /api/studio/lookbook/pdf);
// the builder maps page remoteIds → library _ids and calls it directly.

const crypto = require('crypto');
const Lookbook = require('../models/Lookbook');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const ClientLogo = require('../models/ClientLogo');
const { notifyAdmin } = require('./approval');
const { deriveCompanyKey } = require('../utils/fieldTrackerImport');

const SHARE_TTL_MS = 90 * 24 * 60 * 60 * 1000;  // 90 days, rotated on re-share
const VIEW_THROTTLE_MS = 10 * 60 * 1000;        // one lastViewedAt stamp / 10 min
const FEEDBACK_CAP = 500;                       // runaway-guard on the array

// Resolve a lookbook's ordered pages against the mockup library. Tiles carry
// whatever the library holds (R2 https URLs after offload, else base64) —
// the same ship-as-is approach the approval page uses for its mockup strip.
async function resolveTiles(lb) {
  const ids = (lb.mockups || []).map((m) => m.remoteId).filter(Boolean);
  if (!ids.length) return [];
  const docs = await StudioLibraryItem.find({ store: 'mockups', remoteId: { $in: ids } })
    .select('remoteId name client thumbnail data pageState.mockupNum').lean();
  const byRid = new Map(docs.map((d) => [d.remoteId, d]));
  return (lb.mockups || []).map((m) => {
    const d = byRid.get(m.remoteId);
    if (!d) return { remoteId: m.remoteId, missing: true, caption: m.caption || '' };
    return {
      remoteId: m.remoteId,
      libraryId: String(d._id),   // for the PDF export (generator resolves by _id)
      name: d.name || '',
      mockupNum: (d.pageState && d.pageState.mockupNum) ? String(d.pageState.mockupNum) : '',
      caption: m.caption || '',
      front: d.thumbnail || '',
      back: d.data || '',
    };
  });
}

const unseenCount = (lb) => (lb.feedback || []).filter((f) => !f.seenAt).length;

// ── Admin ─────────────────────────────────────────────────────────────────────

async function listLookbooks(req, res) {
  try {
    const filter = {};
    if (req.query.companyKey) filter.companyKey = String(req.query.companyKey);
    if (req.query.archived === 'true') filter.status = 'archived';
    else filter.status = { $ne: 'archived' };
    const rows = await Lookbook.find(filter).sort({ updatedAt: -1 }).limit(200).lean();
    res.json(rows.map((lb) => ({
      _id: lb._id,
      companyKey: lb.companyKey, companyName: lb.companyName,
      projectNumber: lb.projectNumber,
      title: lb.title, status: lb.status,
      pageCount: (lb.mockups || []).length,
      unseenFeedback: unseenCount(lb),
      sharedAt: lb.sharedAt, lastViewedAt: lb.lastViewedAt, updatedAt: lb.updatedAt,
    })));
  } catch (err) {
    res.status(500).json({ message: 'Lookbook list failed.' });
  }
}

function pickEditable(body) {
  const out = {};
  for (const f of ['title', 'subtitle', 'projectNumber', 'layout', 'showBack', 'showLabels']) {
    if (body[f] !== undefined) out[f] = body[f];
  }
  if (Array.isArray(body.mockups)) {
    out.mockups = body.mockups
      .filter((m) => m && m.remoteId)
      .map((m) => ({ remoteId: String(m.remoteId), caption: String(m.caption || '') }));
  }
  // Status edits here cover draft↔archived; 'shared' only via /share (it
  // needs a token minted with it).
  if (body.status === 'draft' || body.status === 'archived') out.status = body.status;
  return out;
}

async function createLookbook(req, res) {
  try {
    const b = req.body || {};
    const companyName = String(b.companyName || '').trim();
    const companyKey = String(b.companyKey || '').trim() || deriveCompanyKey(companyName);
    if (!companyKey) return res.status(400).json({ message: 'companyName or companyKey required.' });
    const lb = await Lookbook.create({
      companyKey, companyName,
      projectNumber: String(b.projectNumber || ''),
      title: String(b.title || '').trim() || (companyName ? `${companyName} Lookbook` : 'Lookbook'),
      subtitle: String(b.subtitle || ''),
      mockups: pickEditable(b).mockups || [],
    });
    res.status(201).json({ lookbook: lb });
  } catch (err) {
    res.status(500).json({ message: 'Lookbook create failed.' });
  }
}

async function getLookbook(req, res) {
  try {
    const lb = await Lookbook.findById(req.params.id).lean();
    if (!lb) return res.status(404).json({ message: 'Lookbook not found.' });
    res.json({ lookbook: lb, tiles: await resolveTiles(lb), unseenFeedback: unseenCount(lb) });
  } catch (err) {
    res.status(500).json({ message: 'Lookbook load failed.' });
  }
}

async function patchLookbook(req, res) {
  try {
    const set = pickEditable(req.body || {});
    const lb = await Lookbook.findByIdAndUpdate(req.params.id, { $set: set }, { new: true, runValidators: true }).lean();
    if (!lb) return res.status(404).json({ message: 'Lookbook not found.' });
    res.json({ lookbook: lb, tiles: await resolveTiles(lb) });
  } catch (err) {
    res.status(500).json({ message: 'Lookbook update failed.' });
  }
}

// Mint (or rotate) the share token and flip to 'shared'. The link is the
// deliverable: /lookbook/:id?token=… on the public site.
async function shareLookbook(req, res) {
  try {
    const lb = await Lookbook.findById(req.params.id);
    if (!lb) return res.status(404).json({ message: 'Lookbook not found.' });
    if (!(lb.mockups || []).length) return res.status(400).json({ message: 'Add at least one mockup before sharing.' });
    const rotate = req.body && req.body.rotate === true;
    const expired = lb.shareTokenExpiresAt && lb.shareTokenExpiresAt < new Date();
    if (!lb.shareToken || rotate || expired) {
      lb.shareToken = crypto.randomBytes(16).toString('hex');
    }
    lb.shareTokenExpiresAt = new Date(Date.now() + SHARE_TTL_MS);
    lb.status = 'shared';
    lb.sharedAt = lb.sharedAt || new Date();
    await lb.save();
    res.json({
      lookbook: lb.toObject(),
      sharePath: `/lookbook/${lb._id}?token=${lb.shareToken}`,
    });
  } catch (err) {
    res.status(500).json({ message: 'Share failed.' });
  }
}

async function markFeedbackSeen(req, res) {
  try {
    const lb = await Lookbook.findById(req.params.id);
    if (!lb) return res.status(404).json({ message: 'Lookbook not found.' });
    const now = new Date();
    for (const f of lb.feedback) { if (!f.seenAt) f.seenAt = now; }
    await lb.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Update failed.' });
  }
}

// ── Public (token-gated) ─────────────────────────────────────────────────────

async function loadByToken(req) {
  const token = String(req.query.token || req.body?.token || '');
  if (!token) return { status: 404 };
  const lb = await Lookbook.findById(req.params.id);
  if (!lb || !lb.shareToken || lb.shareToken !== token || lb.status === 'archived') return { status: 404 };
  if (lb.shareTokenExpiresAt && lb.shareTokenExpiresAt < new Date()) return { status: 410 };
  return { lb };
}

async function publicGetLookbook(req, res) {
  try {
    const { lb, status } = await loadByToken(req);
    if (!lb) return res.status(status).json({ message: status === 410 ? 'This lookbook link has expired.' : 'Lookbook not found.' });

    // Throttled view stamp (mirror of the approval page's viewed event).
    const now = new Date();
    if (!lb.lastViewedAt || (now - lb.lastViewedAt) > VIEW_THROTTLE_MS) {
      lb.lastViewedAt = now;
      lb.save().catch(() => {});
    }

    const logo = await ClientLogo.findOne({ companyKey: lb.companyKey }).select('imageDataUrl').lean();
    const tiles = (await resolveTiles(lb)).filter((t) => !t.missing);
    res.json({
      title: lb.title, subtitle: lb.subtitle,
      companyName: lb.companyName,
      logo: (logo && logo.imageDataUrl) || '',
      layout: lb.layout, showBack: lb.showBack, showLabels: lb.showLabels,
      mockups: tiles.map((t) => ({
        remoteId: t.remoteId, name: t.name, mockupNum: t.mockupNum,
        caption: t.caption, front: t.front, back: t.back,
      })),
      // The client sees the reactions so far (their own prior taps included);
      // internal ack state stays server-side.
      feedback: (lb.feedback || []).map((f) => ({
        mockupRemoteId: f.mockupRemoteId, reaction: f.reaction,
        comment: f.comment, by: f.by, at: f.at,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: 'Lookbook load failed.' });
  }
}

async function publicPostFeedback(req, res) {
  try {
    const { lb, status } = await loadByToken(req);
    if (!lb) return res.status(status).json({ message: status === 410 ? 'This lookbook link has expired.' : 'Lookbook not found.' });
    if ((lb.feedback || []).length >= FEEDBACK_CAP) return res.status(429).json({ message: 'Feedback limit reached.' });

    const b = req.body || {};
    const reaction = ['up', 'down', ''].includes(b.reaction) ? b.reaction : '';
    const comment = String(b.comment || '').slice(0, 2000).trim();
    if (!reaction && !comment) return res.status(400).json({ message: 'Nothing to save.' });
    const entry = {
      mockupRemoteId: String(b.mockupRemoteId || ''),
      reaction,
      comment,
      by: String(b.by || '').slice(0, 120).trim(),
      at: new Date(),
    };
    // A re-tap on the same mockup by the same person REPLACES their prior
    // reaction (a client changing their mind isn't two votes) — comments
    // always append.
    if (reaction && !comment) {
      const prior = (lb.feedback || []).find((f) => f.mockupRemoteId === entry.mockupRemoteId && f.reaction && !f.comment && f.by === entry.by);
      if (prior) { prior.reaction = reaction; prior.at = entry.at; prior.seenAt = null; }
      else lb.feedback.push(entry);
    } else {
      lb.feedback.push(entry);
    }
    await lb.save();

    // Best-effort heads-up — the hub signal is the durable surface.
    const what = [reaction && (reaction === 'up' ? '👍' : '👎'), comment && `"${comment.slice(0, 140)}"`].filter(Boolean).join(' · ');
    notifyAdmin(
      `Lookbook feedback — ${lb.companyName || lb.companyKey}`,
      `<p><b>${entry.by || 'The client'}</b> on <b>${lb.title}</b>${entry.mockupRemoteId ? ' (a mockup)' : ''}: ${what}</p>`,
    ).catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Feedback failed.' });
  }
}

module.exports = {
  listLookbooks, createLookbook, getLookbook, patchLookbook,
  shareLookbook, markFeedbackSeen,
  publicGetLookbook, publicPostFeedback,
};
