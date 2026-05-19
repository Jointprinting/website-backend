const StudioLibraryItem = require('../models/StudioLibraryItem');

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
    const { name, data, thumbnail, client, pageState, savedAt, remoteId } = req.body;

    // Upsert by remoteId if provided (client re-saves same item)
    if (remoteId) {
      const existing = await StudioLibraryItem.findOne({ remoteId });
      if (existing) {
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
    res.status(500).json({ message: 'Failed to save item.' });
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
