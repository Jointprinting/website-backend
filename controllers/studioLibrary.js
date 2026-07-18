const mongoose = require('mongoose');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const r2 = require('../services/r2');
const { deriveCompanyKey, normMockupNum } = require('../utils/companyKey');

// Best-effort: free the R2 objects an item owned. Only called on delete —
// update-replacement cleanup lives in saveItem.
function _freeR2(item) {
  if (!item) return;
  try {
    if (r2.isR2Url(item.thumbnail)) r2.deleteByUrl(item.thumbnail);
    if (r2.isR2Url(item.data)) r2.deleteByUrl(item.data);
  } catch (_) { /* paid-storage cleanup must never fail the request */ }
}

// One-time backfill (idempotent, runs at boot from server.js): give every
// library doc missing a remoteId one derived from its _id, so the studio's
// sync can dedupe it instead of re-importing it as a fresh row on every load.
async function backfillRemoteIds() {
  const r = await StudioLibraryItem.updateMany(
    { $or: [{ remoteId: '' }, { remoteId: null }, { remoteId: { $exists: false } }] },
    [{ $set: { remoteId: { $concat: ['srv-', { $toString: '$_id' }] } } }],
  );
  if (r.modifiedCount > 0) console.log(`[studioLibrary] backfilled remoteId on ${r.modifiedCount} docs`);
}

async function listItems(req, res) {
  try {
    const { store } = req.params;
    if (!['blanks','logos','mockups'].includes(store))
      return res.status(400).json({ message: 'Invalid store.' });
    // Summary mode (?summary=1) returns just what list/grid views need — the
    // thumbnail (now an R2 URL), name, client, mockup #, and id — without the
    // heavy pageState composites or back image. The Order Tracker uses this so
    // the order page loads fast even with hundreds of mockups; the studio's own
    // sync still pulls the full documents for offline editing.
    const summary = req.query.summary === '1' || req.query.summary === 'true';
    // Client-scoped mockups (?companyKey): the lookbook picker and CRM design
    // library ask for just one client's mockups — spanning every project — via
    // the canonical companyKey. Filters the same summary payload, so no new
    // shape. Only meaningful for the mockups store; ignored for blanks/logos.
    const filter = { store };
    const companyKey = String(req.query.companyKey || '').trim();
    if (companyKey && store === 'mockups') filter.companyKey = companyKey;
    const q = StudioLibraryItem.find(filter).sort({ savedAt: -1 });
    // `data` (the BACK composite, an R2 URL post-migration) rides along so
    // the confirmation builder can offer + preview the back side; without it
    // the "Show back" toggle could never appear.
    // `extraViews` (pages 2+ front composites) are R2 URLs — tiny strings, not
    // base64 — so they ride in the summary payload cheaply. Without them the
    // Studio-side consumers (Confirmation, Quoter, Lookbook) can only ever show
    // the front + back; the public Approval page already gets them via its own
    // payload. Shipping them here lets every surface render every view.
    // Note: extraBackViews is deliberately NOT in the summary. It's index-aligned
    // with '' placeholders (not URL-filtered like extraViews), so exposing it in the
    // light payload would tempt a consumer to read misaligned data — the editor's
    // rehydrate reads it from the FULL doc instead. Keep it full-doc-only.
    if (summary) q.select('store name thumbnail data client savedAt remoteId extraViews pageState.mockupNum pageState.projectNumber');
    const items = await q.lean();
    if (summary) {
      // Keep the summary payload light: R2-hosted backs ship as URLs, but a
      // legacy inline-base64 back (multi-MB) is stripped down to a hasBack
      // flag — the builder can still offer the toggle, and the PDF/approval
      // surfaces (which fetch full docs) render the actual image.
      items.forEach(it => {
        if (it.data && !/^https?:\/\//i.test(it.data)) {
          it.hasBack = true;
          delete it.data;
        } else if (it.data) {
          it.hasBack = true;
        }
        // Same rule for extra views: R2 URLs stay (tiny), but a legacy
        // inline-base64 view (multi-MB, pre-R2) would blow up the summary —
        // drop those, keeping only the URL-backed ones. Full-doc surfaces
        // (PDF/approval) still render every view from the un-stripped document.
        if (Array.isArray(it.extraViews)) {
          it.extraViews = it.extraViews.filter(v => typeof v === 'string' && /^https?:\/\//i.test(v));
        }
      });
    }
    res.json(items);
  } catch (err) {
    console.error('[studioLibrary] list error:', err);
    res.status(500).json({ message: 'Failed to list items.' });
  }
}

// GET /library/:store/full?ids=a,b,c — full documents for specific remoteIds.
// The studio's sync pulls the light summary list first, decides which items
// are actually new (or newer than its local copy), and fetches only those
// here — so a steady-state open downloads a few KB of metadata instead of
// every mockup's inline base64. Capped per call; the studio batches.
async function getByRemoteIds(req, res) {
  try {
    const { store } = req.params;
    if (!['blanks','logos','mockups'].includes(store))
      return res.status(400).json({ message: 'Invalid store.' });
    const ids = String(req.query.ids || '')
      .split(',').map((s) => s.trim()).filter(Boolean).slice(0, 50);
    if (!ids.length) return res.json([]);
    const items = await StudioLibraryItem.find({ store, remoteId: { $in: ids } }).lean();
    res.json(items);
  } catch (err) {
    console.error('[studioLibrary] getByRemoteIds error:', err);
    res.status(500).json({ message: 'Failed to fetch items.' });
  }
}

// Anti-clobber id resolver (pure, unit-tested). When a mockup save's remoteId
// already holds a DIFFERENT mockup number, return a STABLE derived id
// (`<id>::<num>`) so the save can't overwrite the original — and repeated saves
// of the same duplicate converge on that one forked doc (idempotent). No
// conflict (same number, or a number is missing) → the id is unchanged.
function resolveMockupRemoteId(remoteId, incomingNum, existingNum) {
  if (!incomingNum || !existingNum) return remoteId;   // nothing to compare against
  if (incomingNum === existingNum) return remoteId;    // legit re-save of the same mockup
  const suffix = `::${incomingNum}`;
  return String(remoteId).endsWith(suffix) ? remoteId : `${remoteId}${suffix}`;
}

async function saveItem(req, res) {
  try {
    const { store } = req.params;
    if (!['blanks','logos','mockups'].includes(store))
      return res.status(400).json({ message: 'Invalid store.' });
    let { name, data, thumbnail, client, pageState, pages, extraViews, extraBackViews, savedAt, remoteId } = req.body;

    // Stamp the canonical companyKey so this mockup joins the client cleanly
    // (lookbook picker / CRM design library). Prefer an explicit key from the
    // client, else derive it from the mockup's `client` name the same way an
    // Order does. Only mockups carry it; blanks/logos stay unkeyed.
    const companyKey = store === 'mockups'
      ? (String(req.body.companyKey || '').trim() || deriveCompanyKey(client))
      : '';

    // Offload base64 images to R2 (when configured) so the document stays small
    // and well under Mongo's 16MB ceiling. uploadDataUrl returns the value
    // unchanged if it's already a URL or not base64, so this is safe to call
    // blindly. pageState composites are left inline for now — they're only
    // pulled when editing a single mockup, not in lists or the client link.
    if (r2.isR2Configured()) {
      try {
        [thumbnail, data] = await Promise.all([
          r2.uploadDataUrl(thumbnail, `${store}/img`),
          r2.uploadDataUrl(data, `${store}/img`),
        ]);
        // Multi-page mockups: each extra view offloads exactly like the
        // thumbnail — the doc stores URLs, the images live in R2.
        if (Array.isArray(extraViews) && extraViews.length) {
          extraViews = await Promise.all(extraViews.map((v) => r2.uploadDataUrl(v, `${store}/img`)));
        }
        // Extra-page BACKS offload exactly like the fronts, so page-2+ backs
        // finally survive to the cloud instead of being dropped on sync.
        if (Array.isArray(extraBackViews) && extraBackViews.length) {
          extraBackViews = await Promise.all(extraBackViews.map((v) => r2.uploadDataUrl(v, `${store}/img`)));
        }
      } catch (e) {
        console.warn('[studioLibrary] R2 upload failed, storing inline:', e.message);
      }
    }

    // BULLETPROOF anti-clobber (mockups): a save whose remoteId already holds a
    // DIFFERENT mockup number means the client reused a source mockup's id for a
    // new/duplicated file — seen when the studio duplicates client-side or an
    // autosave fires as you navigate away. Writing it through would DESTROY the
    // original, so we never do: route the save to a stable derived id
    // (`<id>::<num>`) instead. The original survives untouched, and repeated
    // saves of the same duplicate converge on the one forked doc (idempotent —
    // no proliferation). Same number (or none) → the normal re-save upsert.
    if (remoteId && store === 'mockups') {
      const incomingNum = pageState && pageState.mockupNum ? String(pageState.mockupNum).trim() : '';
      if (incomingNum) {
        const existing = await StudioLibraryItem.findOne({ store, remoteId }).select('pageState.mockupNum').lean();
        const existingNum = existing && existing.pageState && existing.pageState.mockupNum
          ? String(existing.pageState.mockupNum).trim() : '';
        const resolved = resolveMockupRemoteId(remoteId, incomingNum, existingNum);
        if (resolved !== remoteId) {
          console.warn(`[studioLibrary] remoteId ${remoteId} holds #${existingNum}; incoming save is #${incomingNum} — routing to ${resolved} so the original mockup survives.`);
          remoteId = resolved;
        }
      }
    }

    // Upsert by remoteId if provided (client re-saves same item). One atomic
    // findOneAndUpdate instead of find-then-create: the studio fires
    // overlapping pushes (background sync retry + manual save), and the old
    // check-then-act created two docs with the same remoteId when first
    // pushes raced.
    if (remoteId) {
      const fields = {
        store, name, data: data || '', thumbnail: thumbnail || '',
        client: client || '', companyKey, pageState: pageState || null,
        pages: pages || null,
        extraViews: Array.isArray(extraViews) ? extraViews.filter(Boolean) : [],
        // Kept index-aligned to pages[1..] (NOT filtered): a front-only extra page
        // has an '' placeholder here so a later page's back can't shift onto it.
        extraBackViews: Array.isArray(extraBackViews) ? extraBackViews.map((v) => v || '') : [],
        savedAt: savedAt || Date.now(),
      };
      // Scope the match by STORE too, not remoteId alone. A client UUID that (very
      // rarely) collides across stores would otherwise let a mockup save MATCH a
      // blanks/logos doc and flip its `store`, destroying the original. Same-store
      // upsert keeps each kind isolated.
      const prev = await StudioLibraryItem.findOneAndUpdate(
        { store, remoteId },
        { $set: fields, $setOnInsert: { remoteId } },
        { new: false, upsert: true },
      );
      if (prev) {
        // Free the replaced R2 objects (best-effort) when the URL actually changed.
        if (r2.isR2Url(prev.thumbnail) && prev.thumbnail !== thumbnail) r2.deleteByUrl(prev.thumbnail);
        if (r2.isR2Url(prev.data) && prev.data !== data) r2.deleteByUrl(prev.data);
      }
      const item = await StudioLibraryItem.findOne({ remoteId }).lean();
      return res.status(prev ? 200 : 201).json(item);
    }
    const item = await StudioLibraryItem.create({
      store, name, data: data || '', thumbnail: thumbnail || '',
      client: client || '', companyKey, pageState: pageState || null,
      pages: pages || null,
      extraViews: Array.isArray(extraViews) ? extraViews.filter(Boolean) : [],
      // Index-aligned to pages[1..] (NOT filtered) — see the upsert branch above.
      extraBackViews: Array.isArray(extraBackViews) ? extraBackViews.map((v) => v || '') : [],
      savedAt: savedAt || Date.now(),
      // Never store an empty remoteId — docs without one can't be deduped by
      // the studio's sync and get re-imported as new local rows on every load.
      remoteId: `srv-${new mongoose.Types.ObjectId().toString()}`,
    });
    res.status(201).json(item);
  } catch (err) {
    console.error('[studioLibrary] save error:', err);
    // Surface the real cause so the user/operator can act on it. Most common
    // culprits we've actually hit: Mongo "BSONObjectTooLarge" (doc > 16MB —
    // the thumbnail blob is usually the offender) and validation errors.
    res.status(500).json({
      message: err.message || 'Failed to save item.',
      code: err.code || err.name || undefined,
    });
  }
}

// Which companyKey a mockup belongs to (pure, unit-tested). Prefer the order
// that references its number — that carries the authoritative Order.companyKey;
// fall back to deriving from the mockup's free-text `client` name. `orderMap` is
// a Map of normMockupNum → companyKey.
function resolveCompanyKeyFor(mockup, orderMap) {
  const num = mockup && mockup.pageState && mockup.pageState.mockupNum;
  const byOrder = num && orderMap ? orderMap.get(normMockupNum(num)) : '';
  if (byOrder) return byOrder;
  return deriveCompanyKey(mockup && mockup.client);
}

// One-time backfill (idempotent, runs at boot from server.js): stamp companyKey
// on every mockup that lacks one — from the order referencing its number when
// possible (authoritative), else derived from its client name. Only touches docs
// with an empty key, so it's safe to run every boot and re-run is a no-op once
// keyed. New/edited mockups get keyed on save, so this only ever catches legacy.
async function backfillCompanyKeys() {
  const missing = await StudioLibraryItem.find({
    store: 'mockups',
    $or: [{ companyKey: '' }, { companyKey: null }, { companyKey: { $exists: false } }],
  }).select('client pageState.mockupNum').lean();
  if (!missing.length) return 0;

  const Order = require('../models/Order');
  const orders = await Order.find({ mockupNumbers: { $exists: true, $ne: [] } })
    .select('companyKey mockupNumbers').lean();
  const orderMap = new Map();
  for (const o of orders) {
    if (!o.companyKey) continue;
    for (const n of (o.mockupNumbers || [])) {
      const k = normMockupNum(n);
      if (k && !orderMap.has(k)) orderMap.set(k, o.companyKey);
    }
  }

  const ops = [];
  for (const m of missing) {
    const key = resolveCompanyKeyFor(m, orderMap);
    if (key) ops.push({ updateOne: { filter: { _id: m._id }, update: { $set: { companyKey: key } } } });
  }
  if (!ops.length) return 0;
  const r = await StudioLibraryItem.bulkWrite(ops, { ordered: false });
  const n = r.modifiedCount || 0;
  if (n) console.log(`[studioLibrary] backfilled companyKey on ${n} mockup(s).`);
  return n;
}

async function deleteItem(req, res) {
  try {
    const item = await StudioLibraryItem.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found.' });
    _freeR2(item);
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    console.error('[studioLibrary] delete error:', err);
    res.status(500).json({ message: 'Failed to delete item.' });
  }
}

async function deleteByRemoteId(req, res) {
  try {
    const item = await StudioLibraryItem.findOneAndDelete({ remoteId: req.params.remoteId });
    _freeR2(item);
    res.json({ deleted: !!item });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete item.' });
  }
}

module.exports = {
  listItems, getByRemoteIds, saveItem, deleteItem, deleteByRemoteId,
  backfillRemoteIds, resolveMockupRemoteId,
  backfillCompanyKeys, resolveCompanyKeyFor,
};
