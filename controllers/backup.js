// Backup / restore — full-site snapshots so the user can keep weekly
// archives on a hard drive and recover from a wipe. Everything that
// matters goes into a single ZIP: per-collection JSON files plus the
// uploads directory.

const fs       = require('fs');
const path     = require('path');
const archiver = require('archiver');
const unzipper = require('unzipper');

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

// Collections included in a backup. Order matters on restore — anything
// referenced by another collection should come first, but since we're not
// using real foreign keys (everything's denormalized) the order is more
// about restore-step reporting clarity.
//
// SKIPPED (intentionally): JpwApiUsage, JpwSchedulerState,
// JpwSweepPairHistory, DispensaryDensityCache, QuickBooksAuth, BackupLog.
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
];

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
const BACKUP_DUE_DAYS = 7;

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

  const archive = archiver('zip', { zlib: { level: 6 } });
  const counts = {};
  let totalDocs = 0;
  let fileCount = 0;
  let bytes = 0;

  archive.on('data', (chunk) => { bytes += chunk.length; });
  archive.on('warning', (err) => console.warn('archive warning:', err));
  archive.on('error', (err) => {
    console.error('archive error:', err);
    try { res.status(500).end(); } catch (_) {}
  });

  archive.pipe(res);

  try {
    // Manifest first
    archive.append(JSON.stringify({
      schemaVersion: 1,
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

    // Uploaded files (project attachments)
    if (fs.existsSync(UPLOADS_DIR)) {
      const entries = fs.readdirSync(UPLOADS_DIR);
      for (const entry of entries) {
        const p = path.join(UPLOADS_DIR, entry);
        try {
          const stat = fs.statSync(p);
          if (stat.isFile()) {
            archive.file(p, { name: `files/${entry}` });
            fileCount++;
          }
        } catch (_) { /* skip */ }
      }
    }

    await archive.finalize();

    // Log success after the stream is fully sent
    res.on('finish', async () => {
      try {
        await BackupLog.create({
          kind: 'export', status: 'ok',
          collections: counts, totalDocs, fileCount, sizeBytes: bytes,
          note: `Took ${Math.round((Date.now() - startedAt) / 1000)}s`,
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

module.exports = { status, exportAll, restoreAll };
