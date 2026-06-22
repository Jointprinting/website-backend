// Backup / restore — full-site snapshots so the user can keep weekly
// archives on a hard drive and recover from a wipe. Everything that
// matters goes into a single ZIP: per-collection JSON files plus the
// uploads directory.

const fs       = require('fs');
const path     = require('path');
// archiver@8 ships as ESM-only and dropped the callable factory. The base
// Archiver class doesn't wire up the zip format module on its own — you
// have to pick a format-specific subclass (ZipArchive / TarArchive /
// JsonArchive) so `_module` and `_format` are populated. Calling
// `new Archiver('zip', ...)` looked right but blew up at queue-flush time
// with "this._module.append is not a function".
const { ZipArchive } = require('archiver');
const unzipper = require('unzipper');

const r2 = require('../services/r2');
const BackupLog        = require('../models/BackupLog');
const Order            = require('../models/Order');
const ContactSubmission = require('../models/ContactSubmission');
const StudioLibraryItem = require('../models/StudioLibraryItem');
const ClientLogo       = require('../models/ClientLogo');
const Client           = require('../models/Client');
const SiteSetting      = require('../models/SiteSetting');
const Catalog          = require('../models/Catalog');
const Product          = require('../models/Product');
const AdminUser        = require('../models/AdminUser');
const RoadTripLead     = require('../models/RoadTripLead');
const ScriptVersion    = require('../models/ScriptVersion');
const DispensaryDenylist = require('../models/DispensaryDenylist');
const JpwLead          = require('../models/JpwLead');
const ColdCallState    = require('../models/ColdCallState');
const Transaction      = require('../models/Transaction');
const Receipt          = require('../models/Receipt');

// Collections included in a backup. Order matters on restore — anything
// referenced by another collection should come first, but since we're not
// using real foreign keys (everything's denormalized) the order is more
// about restore-step reporting clarity.
//
// SKIPPED (intentionally): JpwApiUsage, JpwSchedulerState,
// JpwSweepPairHistory, DispensaryDensityCache, GoogleDriveAuth, BackupLog.
// These are either transient rate-limit data, ephemeral scheduler state,
// short-lived caches, or OAuth tokens that shouldn't move between
// environments and can be re-obtained by reconnecting the integration.
const COLLECTIONS = [
  { name: 'Order',             Model: Order             },
  { name: 'ContactSubmission', Model: ContactSubmission },
  { name: 'StudioLibraryItem', Model: StudioLibraryItem },
  { name: 'ClientLogo',        Model: ClientLogo        },
  { name: 'Client',            Model: Client            },
  { name: 'SiteSetting',       Model: SiteSetting       },
  { name: 'Catalog',           Model: Catalog           },
  { name: 'Product',           Model: Product           },
  { name: 'AdminUser',         Model: AdminUser         },
  { name: 'RoadTripLead',      Model: RoadTripLead      },
  { name: 'ScriptVersion',     Model: ScriptVersion     },
  { name: 'DispensaryDenylist',Model: DispensaryDenylist },
  { name: 'JpwLead',           Model: JpwLead           },
  { name: 'ColdCallState',     Model: ColdCallState     },
  { name: 'Transaction',       Model: Transaction       },  // the finance ledger
  { name: 'Receipt',           Model: Receipt           },  // receipt records (file URLs)
];

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const BACKUP_DUE_DAYS = 7;

// Reverse of r2's EXT_BY_MIME, for restoring receipt files with a sensible
// Content-Type so the browser renders them inline instead of downloading.
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml', heic: 'image/heic', pdf: 'application/pdf',
};

// Every R2 URL referenced by the finance ledger or a receipt record. These are
// the receipt/invoice images — they live in Cloudflare R2, not in MongoDB, so
// the JSON dumps alone would leave them out of the backup. We pull the actual
// bytes into the archive so a Cloudflare/R2 outage can't take the only copy.
async function collectReceiptUrls() {
  const urls = new Set();
  const txns = await Transaction.find({ receiptUrl: { $ne: '' } }, 'receiptUrl').lean();
  for (const t of txns) if (r2.isR2Url(t.receiptUrl)) urls.add(t.receiptUrl);
  const recs = await Receipt.find({ fileUrl: { $ne: '' } }, 'fileUrl').lean();
  for (const r of recs) if (r2.isR2Url(r.fileUrl)) urls.add(r.fileUrl);
  return [...urls];
}

// Append the full backup payload (manifest + per-collection JSON + uploaded
// files + R2 receipt images) to an already-piped archive. Shared by the HTTP
// download (exportAll) and the Google Drive push (writeBackupToFile) so both
// produce an identical, complete archive. Returns counts for the BackupLog.
async function appendBackupContents(archive) {
  const counts = {};
  let totalDocs = 0, fileCount = 0, r2Count = 0, r2Missing = 0;

  // Manifest first
  archive.append(JSON.stringify({
    schemaVersion: 2,
    createdAt: new Date().toISOString(),
    collections: COLLECTIONS.map(c => c.name),
  }, null, 2), { name: 'manifest.json' });

  // Per-collection JSON dumps
  for (const { name, Model } of COLLECTIONS) {
    const docs = await Model.find({}).lean();
    counts[name] = docs.length;
    totalDocs += docs.length;
    archive.append(JSON.stringify(docs, null, 2), { name: `data/${name}.json` });
  }

  // Uploaded files (project attachments stored on local disk)
  if (fs.existsSync(UPLOADS_DIR)) {
    for (const entry of fs.readdirSync(UPLOADS_DIR)) {
      const p = path.join(UPLOADS_DIR, entry);
      try {
        if (fs.statSync(p).isFile()) { archive.file(p, { name: `files/${entry}` }); fileCount++; }
      } catch (_) { /* skip */ }
    }
  }

  // Receipt/invoice images out of R2, keyed by their object key so a restore
  // can re-upload to the exact same key (preserving every stored URL).
  if (r2.isR2Configured()) {
    const urls = await collectReceiptUrls();
    for (const url of urls) {
      const key = r2.keyFromUrl(url);
      if (!key) continue;
      const buf = await r2.getBufferByUrl(url);
      if (!buf) { r2Missing++; continue; }       // object missing/unreadable — skip, don't abort
      archive.append(buf, { name: `r2/${key}` });
      r2Count++;
    }
  }

  return { counts, totalDocs, fileCount, r2Count, r2Missing };
}

// Build a complete backup ZIP to a file on disk and resolve with its stats.
// Used by the Google Drive auto-push, which needs the finished bytes to upload
// (unlike the HTTP export, which streams straight to the response).
function writeBackupToFile(filePath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    const archive = new ZipArchive({ zlib: { level: 6 } });
    let bytes = 0, stats = null;
    archive.on('data', (c) => { bytes += c.length; });
    archive.on('warning', (e) => console.warn('archive warning:', e));
    archive.on('error', reject);
    out.on('error', reject);
    out.on('close', () => resolve({ ...(stats || {}), sizeBytes: bytes }));
    archive.pipe(out);
    appendBackupContents(archive)
      .then((s) => { stats = s; return archive.finalize(); })
      .catch(reject);
  });
}

// GET /api/admin/backup/status
const status = async (req, res) => {
  try {
    const last = await BackupLog.findOne({ kind: 'export', status: 'ok' }).sort({ at: -1 }).lean();
    const lastImport = await BackupLog.findOne({ kind: 'import', status: 'ok' }).sort({ at: -1 }).lean();
    const lastAt  = last ? last.at : null;
    const days = lastAt ? Math.floor((Date.now() - new Date(lastAt).getTime()) / (24*60*60*1000)) : null;
    const isDue = days === null || days >= BACKUP_DUE_DAYS;
    res.json({
      lastBackupAt: lastAt,
      lastBackupDays: days,
      isDue, dueAfterDays: BACKUP_DUE_DAYS,
      lastImportAt: lastImport ? lastImport.at : null,
      collections: last ? last.collections : null,
    });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

// GET /api/admin/backup/export — streams a ZIP archive
const exportAll = async (req, res) => {
  const startedAt = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `joint-printing-backup-${stamp}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = new ZipArchive({ zlib: { level: 6 } });
  let bytes = 0;

  archive.on('data', (chunk) => { bytes += chunk.length; });
  archive.on('warning', (err) => console.warn('archive warning:', err));
  archive.on('error', (err) => {
    console.error('archive error:', err);
    try { res.status(500).end(); } catch (_) {}
  });

  archive.pipe(res);

  try {
    const { counts, totalDocs, fileCount, r2Count, r2Missing } = await appendBackupContents(archive);
    await archive.finalize();

    // Log success after the stream is fully sent
    res.on('finish', async () => {
      try {
        await BackupLog.create({
          kind: 'export', status: 'ok',
          collections: counts, totalDocs, fileCount: fileCount + r2Count, sizeBytes: bytes,
          note: `Took ${Math.round((Date.now() - startedAt) / 1000)}s` +
            (r2Count ? `; ${r2Count} receipt files` : '') +
            (r2Missing ? `; ${r2Missing} R2 files missing` : ''),
        });
      } catch (e) { console.warn('BackupLog write failed', e.message); }
    });
  } catch (e) {
    console.error('export failed', e);
    try {
      await BackupLog.create({ kind: 'export', status: 'failed', note: e.message });
    } catch (_) {}
    if (!res.headersSent) res.status(500).json({ message: e.message });
  }
};

// POST /api/admin/backup/restore — body: multipart/form-data with file=<zip>
const restoreAll = async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No backup file provided' });
  const startedAt = Date.now();
  const counts = {};
  let totalDocs = 0;
  let fileCount = 0;

  try {
    const buf = fs.readFileSync(req.file.path);
    const directory = await unzipper.Open.buffer(buf);

    // Parse manifest first
    const manifestEntry = directory.files.find(f => f.path === 'manifest.json');
    if (!manifestEntry) {
      throw new Error('Backup file is missing manifest.json — wrong format?');
    }

    // SAFETY: parse + validate every collection JSON in the archive BEFORE
    // we delete anything. Earlier versions of this code did delete-then-
    // insert inside a single loop, so a corrupt Product.json (caught on the
    // 7th collection) would leave the first 6 collections wiped with no
    // recovery. Now an unreadable archive aborts cleanly with the DB intact.
    const prepared = [];
    for (const { name, Model } of COLLECTIONS) {
      const file = directory.files.find(f => f.path === `data/${name}.json`);
      if (!file) {
        counts[name] = 0;
        prepared.push({ name, Model, docs: null });  // null = collection wasn't in archive
        continue;
      }
      const json = (await file.buffer()).toString('utf-8');
      let docs;
      try { docs = JSON.parse(json); } catch (e) {
        throw new Error(`${name}.json is not valid JSON: ${e.message}`);
      }
      if (!Array.isArray(docs)) throw new Error(`${name}.json is not an array`);
      prepared.push({ name, Model, docs });
    }

    // Apply restores now that every JSON has been validated.
    for (const { name, Model, docs } of prepared) {
      if (docs === null) continue;  // collection missing from archive — leave existing rows alone
      await Model.deleteMany({});
      if (docs.length > 0) {
        // Insert in chunks of 500 to avoid Mongo limits on huge collections
        for (let i = 0; i < docs.length; i += 500) {
          await Model.insertMany(docs.slice(i, i + 500), { ordered: false });
        }
      }
      counts[name] = docs.length;
      totalDocs += docs.length;
    }

    // Restore uploaded files
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    for (const file of directory.files) {
      if (!file.path.startsWith('files/') || file.type !== 'File') continue;
      const rel = file.path.replace(/^files\//, '');
      if (!rel || rel.includes('..') || rel.includes('/')) continue;  // ignore subdirs or traversal
      const dest = path.join(UPLOADS_DIR, rel);
      const data = await file.buffer();
      fs.writeFileSync(dest, data);
      fileCount++;
    }

    // Restore R2 receipt images by re-uploading each to its ORIGINAL key, so
    // every receiptUrl/fileUrl already in the restored documents keeps working.
    // Skipped silently if R2 isn't configured on this environment.
    let r2Count = 0;
    if (r2.isR2Configured()) {
      for (const file of directory.files) {
        if (!file.path.startsWith('r2/') || file.type !== 'File') continue;
        const key = file.path.replace(/^r2\//, '');
        if (!key || key.includes('..')) continue;
        const ext = key.split('.').pop().toLowerCase();
        try {
          await r2.uploadToKey(key, await file.buffer(), MIME_BY_EXT[ext] || 'application/octet-stream');
          r2Count++;
        } catch (e) { console.warn('R2 restore failed for', key, e.message); }
      }
    }
    fileCount += r2Count;

    // Cleanup uploaded zip
    try { fs.unlinkSync(req.file.path); } catch (_) {}

    await BackupLog.create({
      kind: 'import', status: 'ok',
      collections: counts, totalDocs, fileCount,
      note: `Restored in ${Math.round((Date.now() - startedAt) / 1000)}s`,
    });

    res.json({ ok: true, collections: counts, totalDocs, fileCount });
  } catch (e) {
    try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (_) {}
    try {
      await BackupLog.create({ kind: 'import', status: 'failed', note: e.message });
    } catch (_) {}
    res.status(500).json({ message: e.message });
  }
};

module.exports = { status, exportAll, restoreAll, writeBackupToFile };
