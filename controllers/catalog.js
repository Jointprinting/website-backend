// controllers/catalog.js
//
// Catalog CRUD + PDF streaming.
//
// Storage model: metadata in the `catalogs` Mongo collection, PDF bytes in
// the GridFS `images` bucket (same bucket products use — keeps the gridfs.js
// wiring single-purpose). On delete we remove both.
//
// Public reads are deliberately unauthenticated. Write endpoints all go
// through requireAdmin via the route file.

const mongoose = require('mongoose');
const Catalog = require('../models/Catalog');
const { getGfs } = require('../gridfs');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Streams a Buffer into GridFS and resolves with the new file's ObjectId.
 * Used by createCatalog and replaceCatalogPdf.
 */
function streamBufferToGridfs(buffer, filename, contentType) {
  return new Promise((resolve, reject) => {
    const gfs = getGfs();
    const uploadStream = gfs.openUploadStream(filename, { contentType });
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => resolve(uploadStream.id));
    uploadStream.end(buffer);
  });
}

/**
 * Best-effort GridFS delete. Catalog rows shouldn't fail to delete just
 * because the file is already gone (e.g. a previous failed cleanup).
 */
async function deleteGridfsFile(fileId) {
  if (!fileId) return;
  try {
    const gfs = getGfs();
    await gfs.delete(new mongoose.Types.ObjectId(fileId));
  } catch (err) {
    // The 'FileNotFound' error is fine to swallow. Anything else, log it.
    if (!/FileNotFound|file not found/i.test(String(err.message))) {
      console.warn('[catalog] gridfs delete warning:', err.message);
    }
  }
}

/**
 * Strips fields that shouldn't be settable directly (analytics, IDs,
 * timestamps). Used by both create and update so the contract is consistent.
 */
function sanitizeIncoming(body) {
  const allowed = [
    'title', 'description', 'tags',
    'stylePreset', 'accentColor', 'emoji',
    'sortOrder', 'isPublished',
  ];
  const out = {};
  for (const key of allowed) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  // Coerce tags if it came in as a comma-separated string (multipart forms
  // can't easily send arrays).
  if (typeof out.tags === 'string') {
    out.tags = out.tags.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (typeof out.isPublished === 'string') {
    out.isPublished = out.isPublished === 'true' || out.isPublished === '1';
  }
  if (typeof out.sortOrder === 'string') {
    out.sortOrder = parseInt(out.sortOrder, 10) || 0;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public list — only published catalogs, in display order.
 */
async function listCatalogs(_req, res) {
  try {
    const catalogs = await Catalog.find({ isPublished: true })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
    res.json(catalogs);
  } catch (err) {
    console.error('[catalog] list error:', err);
    res.status(500).json({ message: 'Failed to list catalogs.' });
  }
}

/**
 * Admin list — includes unpublished, sorted the same way.
 */
async function listAllCatalogs(_req, res) {
  try {
    const catalogs = await Catalog.find({})
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();
    res.json(catalogs);
  } catch (err) {
    console.error('[catalog] listAll error:', err);
    res.status(500).json({ message: 'Failed to list catalogs.' });
  }
}

async function getCatalog(req, res) {
  try {
    const catalog = await Catalog.findById(req.params.id).lean();
    if (!catalog) return res.status(404).json({ message: 'Catalog not found.' });
    res.json(catalog);
  } catch (err) {
    res.status(400).json({ message: 'Invalid catalog id.' });
  }
}

/**
 * Streams the PDF to the client. ?download=1 forces a download dialog and
 * increments downloadCount; otherwise it increments viewCount and lets the
 * browser open it inline.
 *
 * Counts are incremented in the background so PDF delivery isn't delayed.
 */
async function streamPdf(req, res) {
  try {
    const catalog = await Catalog.findById(req.params.id).lean();
    if (!catalog || !catalog.pdfFileId) {
      return res.status(404).json({ message: 'Catalog PDF not found.' });
    }
    if (!catalog.isPublished) {
      return res.status(404).json({ message: 'Catalog PDF not found.' });
    }

    const isDownload = req.query.download === '1' || req.query.download === 'true';
    const filename = catalog.pdfFileName || `${catalog.title || 'catalog'}.pdf`;

    res.set('Content-Type', 'application/pdf');
    res.set(
      'Content-Disposition',
      `${isDownload ? 'attachment' : 'inline'}; filename="${filename.replace(/"/g, '')}"`
    );

    // Fire-and-forget analytics — don't block the response.
    Catalog.updateOne(
      { _id: catalog._id },
      { $inc: isDownload ? { downloadCount: 1 } : { viewCount: 1 } }
    ).catch((e) => console.warn('[catalog] counter inc failed:', e.message));

    const gfs = getGfs();
    const downloadStream = gfs.openDownloadStream(
      new mongoose.Types.ObjectId(catalog.pdfFileId)
    );
    downloadStream.on('error', (err) => {
      console.error('[catalog] gridfs read error:', err.message);
      if (!res.headersSent) res.status(500).json({ message: 'PDF read error.' });
      else res.end();
    });
    downloadStream.pipe(res);
  } catch (err) {
    console.error('[catalog] streamPdf error:', err);
    if (!res.headersSent) res.status(400).json({ message: 'Invalid catalog id.' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes (admin)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new catalog. Multipart form — fields go in body, the PDF arrives
 * as `pdf` via multer's memory storage. PDF is optional at create time so
 * you can stage metadata first and upload later, but the catalog won't show
 * publicly until it has both a file and isPublished=true.
 */
async function createCatalog(req, res) {
  try {
    const data = sanitizeIncoming(req.body);
    if (!data.title) {
      return res.status(400).json({ message: 'Title is required.' });
    }

    // Default sortOrder = max + 1 so new catalogs land at the bottom.
    if (data.sortOrder === undefined) {
      const last = await Catalog.findOne({}).sort({ sortOrder: -1 }).lean();
      data.sortOrder = last ? (last.sortOrder || 0) + 1 : 0;
    }

    if (req.file) {
      const fileId = await streamBufferToGridfs(
        req.file.buffer,
        req.file.originalname || `${data.title}.pdf`,
        req.file.mimetype || 'application/pdf'
      );
      data.pdfFileId = fileId;
      data.pdfFileName = req.file.originalname || `${data.title}.pdf`;
      data.pdfFileSize = req.file.size;
    }

    const created = await Catalog.create(data);
    res.status(201).json(created);
  } catch (err) {
    console.error('[catalog] create error:', err);
    res.status(500).json({ message: 'Failed to create catalog.' });
  }
}

/**
 * Update catalog metadata only. PDF replacement is a separate endpoint so
 * the contract stays clean (one purpose per request).
 */
async function updateCatalog(req, res) {
  try {
    const updates = sanitizeIncoming(req.body);
    const catalog = await Catalog.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    );
    if (!catalog) return res.status(404).json({ message: 'Catalog not found.' });
    res.json(catalog);
  } catch (err) {
    console.error('[catalog] update error:', err);
    res.status(500).json({ message: 'Failed to update catalog.' });
  }
}

/**
 * Replace the PDF file. The old GridFS file is deleted after the new one
 * lands so we don't accumulate orphans.
 */
async function replaceCatalogPdf(req, res) {
  try {
    if (!req.file) return res.status(400).json({ message: 'No PDF uploaded.' });

    const catalog = await Catalog.findById(req.params.id);
    if (!catalog) return res.status(404).json({ message: 'Catalog not found.' });

    const oldFileId = catalog.pdfFileId;
    const newFileId = await streamBufferToGridfs(
      req.file.buffer,
      req.file.originalname || `${catalog.title}.pdf`,
      req.file.mimetype || 'application/pdf'
    );

    catalog.pdfFileId = newFileId;
    catalog.pdfFileName = req.file.originalname || `${catalog.title}.pdf`;
    catalog.pdfFileSize = req.file.size;
    await catalog.save();

    // Clean up the old file *after* the new one is saved, so we don't
    // accidentally leave a catalog with a deleted file if the save fails.
    await deleteGridfsFile(oldFileId);

    res.json(catalog);
  } catch (err) {
    console.error('[catalog] replacePdf error:', err);
    res.status(500).json({ message: 'Failed to replace PDF.' });
  }
}

/**
 * Accepts { order: [{ id, sortOrder }, ...] }. Used by drag/up-down reorder
 * in Studio. Runs as a bulkWrite so the whole reorder is one round-trip.
 */
async function reorderCatalogs(req, res) {
  try {
    const order = Array.isArray(req.body.order) ? req.body.order : [];
    if (order.length === 0) return res.json({ updated: 0 });

    const ops = order
      .filter((x) => x && x.id)
      .map((x) => ({
        updateOne: {
          filter: { _id: new mongoose.Types.ObjectId(x.id) },
          update: { $set: { sortOrder: parseInt(x.sortOrder, 10) || 0 } },
        },
      }));

    if (ops.length === 0) return res.json({ updated: 0 });
    const result = await Catalog.bulkWrite(ops);
    res.json({ updated: result.modifiedCount });
  } catch (err) {
    console.error('[catalog] reorder error:', err);
    res.status(500).json({ message: 'Failed to reorder catalogs.' });
  }
}

async function deleteCatalog(req, res) {
  try {
    const catalog = await Catalog.findById(req.params.id);
    if (!catalog) return res.status(404).json({ message: 'Catalog not found.' });

    const fileId = catalog.pdfFileId;
    await catalog.deleteOne();
    await deleteGridfsFile(fileId);

    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    console.error('[catalog] delete error:', err);
    res.status(500).json({ message: 'Failed to delete catalog.' });
  }
}

module.exports = {
  listCatalogs,
  listAllCatalogs,
  getCatalog,
  streamPdf,
  createCatalog,
  updateCatalog,
  replaceCatalogPdf,
  reorderCatalogs,
  deleteCatalog,
};
