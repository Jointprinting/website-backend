const StudioLibraryItem = require('../models/StudioLibraryItem');
const r2 = require('../services/r2');

async function listItems(req, res) {
  try {
    const { store } = req.params;
    if (!['blanks','logos','mockups'].includes(store))
      return res.status(400).json({ message: 'Invalid store.' });
    const items = await StudioLibraryItem.find({ store }).sort({ savedAt: -1 }).lean();
    res.json(items);
  } catch (err) {
    console.error('[studioLibrary] list error:', err);
    res.status(500).json({ message: 'Failed to list items.' });
  }
}

async function saveItem(req, res) {
  try {
    const { store } = req.params;
    if (!['blanks','logos','mockups'].includes(store))
      return res.status(400).json({ message: 'Invalid store.' });
    let { name, data, thumbnail, client, pageState, savedAt, remoteId } = req.body;

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
      } catch (e) {
        console.warn('[studioLibrary] R2 upload failed, storing inline:', e.message);
      }
    }

    // Upsert by remoteId if provided (client re-saves same item)
    if (remoteId) {
      const existing = await StudioLibraryItem.findOne({ remoteId });
      if (existing) {
        // Free the replaced R2 objects (best-effort) when the URL actually changed.
        if (r2.isR2Url(existing.thumbnail) && existing.thumbnail !== thumbnail) r2.deleteByUrl(existing.thumbnail);
        if (r2.isR2Url(existing.data) && existing.data !== data) r2.deleteByUrl(existing.data);
        Object.assign(existing, { name, data, thumbnail, client, pageState, savedAt });
        await existing.save();
        return res.json(existing);
      }
    }
    const item = await StudioLibraryItem.create({
      store, name, data: data || '', thumbnail: thumbnail || '',
      client: client || '', pageState: pageState || null,
      savedAt: savedAt || Date.now(), remoteId: remoteId || '',
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

async function deleteItem(req, res) {
  try {
    const item = await StudioLibraryItem.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found.' });
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    console.error('[studioLibrary] delete error:', err);
    res.status(500).json({ message: 'Failed to delete item.' });
  }
}

async function deleteByRemoteId(req, res) {
  try {
    const result = await StudioLibraryItem.deleteOne({ remoteId: req.params.remoteId });
    res.json({ deleted: result.deletedCount > 0 });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete item.' });
  }
}

module.exports = { listItems, saveItem, deleteItem, deleteByRemoteId };
