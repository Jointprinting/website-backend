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
const Order = require('../models/Order');
const { notifyAdmin, _esc } = require('./approval');
const { deriveCompanyKey } = require('../utils/fieldTrackerImport');
const { nextNumber } = require('../utils/sequence');

const SHARE_TTL_MS = 90 * 24 * 60 * 60 * 1000;  // 90 days, rotated on re-share
const VIEW_THROTTLE_MS = 10 * 60 * 1000;        // one lastViewedAt stamp / 10 min
const NOTIFY_THROTTLE_MS = 10 * 60 * 1000;      // one feedback email / lookbook / 10 min
const FEEDBACK_CAP = 500;                       // runaway-guard on the array
const PRICING_THROTTLE_MS = 3 * 60 * 1000;      // one pricing request / lookbook / 3 min
const PRICING_REQ_CAP = 50;                     // runaway-guard on the array
// Real USPS state/territory codes (mirrors controllers/outreach.js parseState's
// vocabulary) — the ship-to extractor only trusts a trailing token in this set.
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA',
  'ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
  'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','PR',
]);

// Resolve a lookbook's ordered pages against the mockup library. Tiles carry
// whatever the library holds (R2 https URLs after offload, else base64) —
// the same ship-as-is approach the approval page uses for its mockup strip.
// `withBack` is public-gallery-only: a legacy non-offloaded back is multi-MB
// inline base64, and the ADMIN builder never renders backs — shipping them on
// every debounced autosave PATCH would be pure waste (the library's own
// summary endpoint strips them for exactly this reason).
async function resolveTiles(lb, { withBack = false } = {}) {
  const ids = (lb.mockups || []).map((m) => m.remoteId).filter(Boolean);
  if (!ids.length) return [];
  const fields = `remoteId name client thumbnail pageState.mockupNum${withBack ? ' data' : ''}`;
  const docs = await StudioLibraryItem.find({ store: 'mockups', remoteId: { $in: ids } })
    .select(fields).lean();
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
      ...(withBack ? { back: d.data || '' } : {}),
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
      viewCount: lb.viewCount || 0,
      pricingRequests: (lb.pricingRequests || []).length,
      archivedAt: lb.archivedAt || null,
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
  // needs a token minted with it). The archivedAt purge clock is stamped in
  // patchLookbook, which can see the CURRENT status — stamping here would
  // reset the 60-day countdown on every PATCH that merely echoes
  // status:'archived' back.
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
    // The purge clock stamps on the TRANSITION only: newly archived → clock
    // starts; restored → clock stops. A PATCH that re-sends status:'archived'
    // on an already-archived lookbook must NOT reset a countdown the owner
    // has been watching.
    if (set.status !== undefined) {
      const current = await Lookbook.findById(req.params.id).select('status').lean();
      if (!current) return res.status(404).json({ message: 'Lookbook not found.' });
      if (set.status === 'archived' && current.status !== 'archived') set.archivedAt = new Date();
      if (set.status !== 'archived' && current.status === 'archived') set.archivedAt = null;
    }
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
  // Only status 'shared' is client-visible — the lifecycle's whole point.
  // Archiving OR restoring to draft kills the link immediately (the token is
  // deliberately not enough on its own: "Restore to draft" must never
  // silently revive a link the archive dialog promised was dead).
  if (!lb || !lb.shareToken || lb.shareToken !== token || lb.status !== 'shared') return { status: 404 };
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
      lb.viewCount = (lb.viewCount || 0) + 1;   // throttled visits, not raw requests
      lb.save().catch(() => {});
    }

    const logo = await ClientLogo.findOne({ companyKey: lb.companyKey }).select('imageDataUrl').lean();
    const tiles = (await resolveTiles(lb, { withBack: true })).filter((t) => !t.missing);
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
    // Best-effort heads-up — the hub signal is the durable surface, so the
    // email is throttled per lookbook (a reaction-tapping script must never
    // flood the inbox) and every client-supplied string is escaped (same
    // _esc treatment the approval flow's notification emails use).
    const now2 = new Date();
    const shouldNotify = !lb.lastFeedbackNotifiedAt || (now2 - lb.lastFeedbackNotifiedAt) > NOTIFY_THROTTLE_MS;
    if (shouldNotify) lb.lastFeedbackNotifiedAt = now2;
    await lb.save();

    if (shouldNotify) {
      const what = [reaction && (reaction === 'up' ? '👍' : '👎'), comment && `"${_esc(comment.slice(0, 140))}"`].filter(Boolean).join(' · ');
      notifyAdmin(
        `Lookbook feedback — ${lb.companyName || lb.companyKey}`,
        `<p><b>${_esc(entry.by) || 'The client'}</b> on <b>${_esc(lb.title)}</b>${entry.mockupRemoteId ? ' (a mockup)' : ''}: ${what}</p>`,
      ).catch(() => {});
    }

    // Echo the updated public feedback so the gallery can update in place —
    // re-fetching the whole payload (every inline mockup image) per 👍 tap
    // would be a multi-MB transfer on legacy non-offloaded lookbooks.
    res.json({
      ok: true,
      feedback: (lb.feedback || []).map((f) => ({
        mockupRemoteId: f.mockupRemoteId, reaction: f.reaction,
        comment: f.comment, by: f.by, at: f.at,
      })),
    });
  } catch (err) {
    res.status(500).json({ message: 'Feedback failed.' });
  }
}

// Whitelist + clamp one "Request pricing" submission. Pure — unit-tested.
// picks: [{ remoteId, qty }] (1..30 picks, qty clamped 1..100000); contact
// strings length-bound; ship-to is free text (the owner reads it — we only
// best-effort extract a trailing 2-letter state for the quote's shipToState).
function cleanPricingRequest(body = {}) {
  const picks = (Array.isArray(body.picks) ? body.picks : [])
    .filter((x) => x && x.remoteId)
    .slice(0, 30)
    .map((x) => ({
      remoteId: String(x.remoteId).slice(0, 100),
      qty: Math.max(1, Math.min(100000, Math.round(Number(x.qty) || 0) || 1)),
    }));
  const shipTo = String(body.shipTo || '').slice(0, 300).trim();
  // Trailing state code with an optional ZIP ("Trenton, NJ" / "Trenton, NJ
  // 08601") — validated against the real state set so "500 Market St" can
  // never seed shipToState 'ST'.
  const st = shipTo.match(/\b([A-Za-z]{2})(?:[,\s]+\d{5}(?:-\d{4})?)?\s*$/);
  const code = st ? st[1].toUpperCase() : '';
  return {
    picks,
    by:     String(body.by    || '').slice(0, 120).trim(),
    email:  String(body.email || '').slice(0, 254).trim(),
    phone:  String(body.phone || '').slice(0, 40).trim(),
    shipTo,
    note:   String(body.note  || '').slice(0, 2000).trim(),
    shipToState: US_STATES.has(code) ? code : '',
  };
}

// POST /api/public/lookbooks/:id/request-pricing?token=… — the gallery's
// "these ones, priced" button. Turns browsing into a live deal with zero
// re-entry: mints a NEW quote-stage project seeded with one quote line per
// picked mockup (qty from the client, costs left for the owner to price),
// nudges the CRM to 'quoting' (up-only), records the request on the lookbook,
// and emails the owner. Always a FRESH project — never appends into a pitch
// the owner may be mid-building on the company's existing quote.
async function publicRequestPricing(req, res) {
  try {
    const { lb, status } = await loadByToken(req);
    if (!lb) return res.status(status).json({ message: status === 410 ? 'This lookbook link has expired.' : 'Lookbook not found.' });
    if ((lb.pricingRequests || []).length >= PRICING_REQ_CAP) return res.status(429).json({ message: 'Request limit reached — email us instead.' });
    const now = new Date();
    if (lb.lastPricingRequestAt && (now - lb.lastPricingRequestAt) < PRICING_THROTTLE_MS) {
      return res.status(429).json({ message: 'Hang on a moment — your last request just came through.' });
    }

    const r = cleanPricingRequest(req.body || {});
    if (!r.picks.length) return res.status(400).json({ message: 'Pick at least one design.' });

    // Resolve ONLY the picked mockups (a public endpoint must not pull a
    // 40-page lookbook's inline thumbnails from Mongo to price two picks).
    const pickSet = new Set(r.picks.map((p) => p.remoteId));
    const tiles = await resolveTiles({ mockups: (lb.mockups || []).filter((m) => pickSet.has(m.remoteId)) });
    const byRid = new Map(tiles.filter((t) => !t.missing).map((t) => [t.remoteId, t]));
    const chosen = r.picks.filter((p) => byRid.has(p.remoteId));
    if (!chosen.length) return res.status(400).json({ message: 'Those designs are no longer available — refresh and try again.' });

    // The join key the seeded project WILL carry: Order's pre-save hook always
    // re-derives companyKey from the names it's given, so pass a companyName
    // that derives stably (falling back to the lookbook's key when the name is
    // blank — never the visitor's typed name) and nudge the CRM under that
    // SAME derived key. Without this, an explicit-key lookbook would flip one
    // CRM company to 'quoting' while the project filed under another key.
    const companyName = lb.companyName || lb.companyKey;
    const projectKey = deriveCompanyKey(companyName) || lb.companyKey;

    // CRM: the company is quoting now (find-or-create, up-only, best-effort —
    // a CRM hiccup never loses the request).
    try {
      const { ensureCompanyForQuoting } = require('./crm');
      await ensureCompanyForQuoting(projectKey, { companyName: lb.companyName });
    } catch (e) {
      console.warn('[lookbooks] ensureCompanyForQuoting skipped:', e.message);
    }

    const projectNumber = await nextNumber('project');
    const contactBits = [
      r.by     && `Contact: ${r.by}`,
      r.email  && `Email: ${r.email}`,
      r.phone  && `Phone: ${r.phone}`,
      r.shipTo && `Ship to: ${r.shipTo}`,
      r.note   && `Note: ${r.note}`,
      `Requested from lookbook "${lb.title}"`,
    ].filter(Boolean).join('\n');
    const order = await Order.create({
      projectNumber,
      companyName,
      clientName: r.by || '',
      status: 'quoted',
      shipToState: r.shipToState,
      notes: contactBits,
      importedFrom: 'lookbook-pricing',
      // One un-priced standalone line per picked design: the client's qty +
      // the mockup's identity; blank/print costs and the price are the
      // owner's move in the quoter. A URL thumbnail rides along when the
      // library holds one (legacy inline base64 stays out of the order doc —
      // the mockup # links it regardless).
      quoteLines: chosen.map((p) => {
        const t = byRid.get(p.remoteId);
        const img = String(t.front || '');
        return {
          qty: p.qty,
          description: t.caption || t.name || 'Lookbook design',
          mockupNum: t.mockupNum || '',
          image: /^https?:\/\//i.test(img) ? img : '',
        };
      }),
      activity: [{
        kind: 'created', actor: 'client',
        message: `Project #${projectNumber} created from a lookbook pricing request (${chosen.length} design${chosen.length === 1 ? '' : 's'})`,
        at: now,
      }],
    });

    lb.pricingRequests.push({
      at: now, by: r.by, email: r.email, phone: r.phone, shipTo: r.shipTo, note: r.note,
      picks: chosen.map((p) => ({ remoteId: p.remoteId, name: (byRid.get(p.remoteId) || {}).name || '', qty: p.qty })),
      projectNumber,
    });
    lb.lastPricingRequestAt = now;
    await lb.save();

    const list = chosen.map((p) => `${_esc((byRid.get(p.remoteId) || {}).name || 'design')} × ${p.qty}`).join(' · ');
    notifyAdmin(
      `Pricing request — ${lb.companyName || lb.companyKey}`,
      `<p><b>${_esc(r.by) || 'The client'}</b> wants pricing from <b>${_esc(lb.title)}</b>: ${list}.</p>`
      + `<p>${r.shipTo ? `Ship to: ${_esc(r.shipTo)}<br/>` : ''}${r.note ? `Note: ${_esc(r.note)}<br/>` : ''}`
      + `Seeded project <b>#${projectNumber}</b> — open the Order Tracker to price it.</p>`,
    ).catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ message: 'Request failed — try again or email us.' });
  }
}

module.exports = {
  listLookbooks, createLookbook, getLookbook, patchLookbook,
  shareLookbook, markFeedbackSeen,
  publicGetLookbook, publicPostFeedback, publicRequestPricing,
  // exported for tests
  cleanPricingRequest,
};
